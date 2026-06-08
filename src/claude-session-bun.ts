import * as os from "node:os"
import * as fs from "node:fs"
import * as path from "node:path"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"

/**
 * Persistent interactive Claude Code session driven over Bun's NATIVE PTY
 * (Bun.spawn `terminal` option = openpty on POSIX, ConPTY on Windows). This is
 * the in-process Bun port of claude-tui-bridge/src/claudeSession.ts: same
 * design, node-pty swapped for Bun's own ConPTY so it runs inside opencode's
 * Bun runtime with NO node sidecar and NO node-pty dependency.
 *
 *   - ONE long-lived interactive `claude` process per session (multi-turn),
 *   - turns injected by writing into the terminal (bracketed paste + Enter),
 *   - replies captured by tailing the session JSONL transcript
 *     (~/.claude/projects/<encoded-cwd>/<session-id>.jsonl) and parsing the
 *     assistant records; completion detected by a terminal `stop_reason`.
 *
 * Driving the INTERACTIVE TUI (real TTY) keeps model calls on the subscription
 * billing path (not `claude -p` / Agent SDK, which meter after 2026-06-15).
 */

function resolveClaude(cmd = "claude"): string {
  if (path.isAbsolute(cmd) && fs.existsSync(cmd)) return cmd
  const viaBun = Bun.which(cmd)
  if (viaBun) return viaBun
  const isWin = os.platform() === "win32"
  try {
    const out = execFileSync(isWin ? "where" : "which", [cmd], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    const first = out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .find((p) => fs.existsSync(p))
    if (first) return first
  } catch {}
  throw new Error(`Could not resolve command on PATH: ${cmd}`)
}

/** Claude encodes the absolute cwd into the transcript dir name by replacing
 *  EVERY non-alphanumeric char with `-` (no collapsing of runs). Verified on
 *  Windows against ~/.claude/projects, e.g.:
 *    C:\code\my-app    -> C--code-my-app
 *    C:\dev\My Project -> C--dev-My-Project   (the space also becomes `-`). */
export function encodeCwd(cwd: string): string {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, "-")
}

export interface TurnResult {
  text: string
  stopReason: string | null
  usage: any | null
  cacheReadTokens: number
  cacheCreationTokens: number
  ephemeral1hTokens: number
  ephemeral5mTokens: number
  inputTokens: number
  outputTokens: number
  elapsedMs: number
}

export interface ClaudeSessionOptions {
  cwd?: string
  model?: string
  /** '' bypasses CLAUDE.md + user/project/local settings load (fast tests).
   *  null/undefined omits the flag entirely (normal settings). */
  settingSources?: string | null
  extraArgs?: string[]
  cols?: number
  rows?: number
  bootMinMs?: number
  bootQuietMs?: number
  bootMaxMs?: number
  pollMs?: number
  turnTimeoutMs?: number
  /** false = plain write(prompt)+Enter; true = wrap in bracketed-paste so
   *  multi-line prompts don't submit early. Default true. */
  bracketedPaste?: boolean
  /** Abort the call (during boot or an in-flight turn): kills the process and
   *  rejects with an "aborted" error. */
  signal?: AbortSignal
  debug?: boolean
}

const TERMINAL_STOP = new Set(["end_turn", "stop_sequence", "max_tokens"])
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export class ClaudeSession {
  readonly sessionId: string
  readonly cwd: string
  readonly jsonlPath: string
  raw = ""

  private proc: BunSubprocess | null = null
  private cursor = 0 // index into transcript split('\n')
  private lastDataAt = 0
  private exited = false
  private aborted = false
  private readonly signal?: AbortSignal
  private readonly o: Required<
    Omit<ClaudeSessionOptions, "model" | "settingSources" | "extraArgs" | "signal">
  > &
    Pick<ClaudeSessionOptions, "model" | "settingSources" | "extraArgs">

  constructor(opts: ClaudeSessionOptions = {}) {
    this.cwd = path.resolve(opts.cwd ?? process.cwd())
    this.signal = opts.signal
    this.sessionId = randomUUID()
    this.jsonlPath = path.join(
      os.homedir(),
      ".claude",
      "projects",
      encodeCwd(this.cwd),
      `${this.sessionId}.jsonl`,
    )
    this.o = {
      cwd: this.cwd,
      model: opts.model,
      settingSources: opts.settingSources,
      extraArgs: opts.extraArgs ?? [],
      cols: opts.cols ?? 200,
      rows: opts.rows ?? 50,
      bootMinMs: opts.bootMinMs ?? 3000,
      bootQuietMs: opts.bootQuietMs ?? 1500,
      bootMaxMs: opts.bootMaxMs ?? 25000,
      pollMs: opts.pollMs ?? 250,
      turnTimeoutMs: opts.turnTimeoutMs ?? 120000,
      bracketedPaste: opts.bracketedPaste ?? true,
      debug: opts.debug ?? false,
    }
  }

  async start(): Promise<void> {
    if (this.signal?.aborted) throw new Error("aborted before start")
    this.signal?.addEventListener(
      "abort",
      () => {
        this.aborted = true
        this.dispose()
      },
      { once: true },
    )
    const claude = resolveClaude()
    const args: string[] = ["--session-id", this.sessionId]
    if (this.o.model) args.push("--model", this.o.model)
    if (this.o.settingSources !== null && this.o.settingSources !== undefined) {
      args.push("--setting-sources", this.o.settingSources)
    }
    if (this.o.extraArgs && this.o.extraArgs.length) args.push(...this.o.extraArgs)

    if (this.o.debug)
      process.stderr.write(`[session] spawn: ${claude} ${args.join(" ")}\n`)

    this.lastDataAt = Date.now()
    this.proc = Bun.spawn([claude, ...args], {
      cwd: this.cwd,
      env: { ...process.env, TERM: "xterm-256color" },
      terminal: {
        cols: this.o.cols,
        rows: this.o.rows,
        data: (_term, d) => {
          this.lastDataAt = Date.now()
          const chunk = Buffer.from(d).toString("utf8")
          this.raw += chunk
          if (this.o.debug) process.stdout.write(chunk)
        },
      },
    })
    this.proc.exited.then(() => {
      this.exited = true
      this.proc = null
    })

    await this.waitForBoot()
    this.cursor = this.lineCount()
  }

  /** Wait until the TUI has been quiet for bootQuietMs (Ink ready), bounded by
   *  bootMinMs..bootMaxMs. */
  private async waitForBoot(): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < this.o.bootMaxMs) {
      await delay(150)
      if (this.aborted) throw new Error("aborted during boot")
      if (this.exited) throw new Error("claude exited during boot")
      const elapsed = Date.now() - start
      const sinceData = Date.now() - this.lastDataAt
      if (elapsed >= this.o.bootMinMs && sinceData >= this.o.bootQuietMs) return
    }
  }

  private readRawLines(): string[] {
    try {
      return fs.readFileSync(this.jsonlPath, "utf8").split("\n")
    } catch {
      return []
    }
  }

  /** Count of complete lines (split('\n') minus the trailing/partial element). */
  private lineCount(): number {
    const lines = this.readRawLines()
    return lines.length > 0 ? lines.length - 1 : 0
  }

  /**
   * Inject a turn into the live session and return the assistant reply once a
   * terminal stop_reason is observed in the transcript.
   */
  async ask(prompt: string, perTurnTimeoutMs?: number): Promise<TurnResult> {
    if (this.aborted) throw new Error("aborted")
    if (!this.proc || this.exited)
      throw new Error("session not started or already exited")
    const timeout = perTurnTimeoutMs ?? this.o.turnTimeoutMs
    const t0 = Date.now()

    // Inject. Bracketed paste keeps multi-line prompts from submitting early.
    if (this.o.bracketedPaste) {
      this.proc.terminal.write("\x1b[200~" + prompt + "\x1b[201~")
    } else {
      this.proc.terminal.write(prompt)
    }
    await delay(200)
    this.proc.terminal.write("\r")

    const collected: string[] = []
    let lastUsage: any = null
    let stopReason: string | null = null
    const deadline = Date.now() + timeout

    while (Date.now() < deadline) {
      await delay(this.o.pollMs)
      if (this.aborted) throw new Error("aborted mid-turn")
      if (this.exited) throw new Error("claude exited mid-turn")
      const lines = this.readRawLines()
      const lastComplete = lines.length - 1 // exclusive bound; trailing/partial line skipped
      if (lastComplete <= this.cursor) continue

      for (let i = this.cursor; i < lastComplete; i++) {
        const s = lines[i]
        if (!s || !s.trim()) continue
        let rec: any
        try {
          rec = JSON.parse(s)
        } catch {
          continue
        }
        if (rec.type === "assistant" && rec.message) {
          for (const b of rec.message.content ?? []) {
            if (b?.type === "text" && typeof b.text === "string")
              collected.push(b.text)
          }
          if (rec.message.usage) lastUsage = rec.message.usage
          if (
            rec.message.stop_reason &&
            TERMINAL_STOP.has(rec.message.stop_reason)
          ) {
            stopReason = rec.message.stop_reason
          }
        }
      }
      this.cursor = lastComplete
      if (stopReason) break
    }

    if (!stopReason) {
      throw new Error(
        `turn timed out after ${timeout}ms (no terminal assistant record; collected ${collected.length} text block(s))`,
      )
    }

    const u = lastUsage ?? {}
    return {
      text: collected.join("\n").trim(),
      stopReason,
      usage: lastUsage,
      cacheReadTokens: u.cache_read_input_tokens ?? 0,
      cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
      ephemeral1hTokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      ephemeral5mTokens: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
      inputTokens: u.input_tokens ?? 0,
      outputTokens: u.output_tokens ?? 0,
      elapsedMs: Date.now() - t0,
    }
  }

  dispose(): void {
    if (this.proc) {
      try {
        this.proc.terminal.write("\x03")
      } catch {}
      try {
        this.proc.kill()
      } catch {}
      try {
        this.proc.terminal.close()
      } catch {}
    }
    this.proc = null
  }
}

/** One-shot convenience (drop-in for `claude -p`): start, ask, dispose. */
export async function askOnce(
  prompt: string,
  opts: ClaudeSessionOptions = {},
): Promise<TurnResult> {
  const s = new ClaudeSession(opts)
  await s.start()
  try {
    return await s.ask(prompt)
  } finally {
    s.dispose()
  }
}
