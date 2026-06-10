import { EventEmitter } from "node:events"
import { ClaudeSession } from "./claude-session-bun.js"
import type { ActiveProcess } from "./session-manager.js"
import { log } from "./logger.js"

export interface InteractiveSpawnOptions {
  cwd: string
  model?: string
  /** Bridged Claude `--mcp-config` file paths (from effectiveMcpConfig). */
  mcpConfigPaths?: string[]
  /** permissions.allow rules (e.g. mcp__server__*, Bash, Edit). */
  permissionsAllow?: string[]
  /** "default" | "bypassPermissions" (the latter dodges the folder-trust gate). */
  permissionMode?: string
  /** "" = skip CLAUDE.md + ambient settings (default); null = normal settings. */
  settingSources?: string | null
}

/**
 * Adapt a ClaudeSession (interactive Bun ConPTY transport) to the ActiveProcess
 * contract the doStream line handler depends on. The shim's `proc.stdin.write`
 * injects a turn into the live interactive `claude` and re-emits each new JSONL
 * transcript record on `lineEmitter` as a 'line' event, plus a synthetic
 * `{type:'result'}` line on a terminal stop_reason so the existing finish branch
 * (usage + providerMetadata + controller.close) fires unchanged.
 *
 * No node-pty, no node sidecar: runs in-process under opencode's Bun (which
 * bundles a Bun version with native ConPTY). Interactive = subscription billing.
 */
export function spawnInteractiveProcess(
  opts: InteractiveSpawnOptions,
): ActiveProcess {
  const extraArgs: string[] = []
  if (opts.mcpConfigPaths && opts.mcpConfigPaths.length > 0) {
    extraArgs.push(
      "--mcp-config",
      ...opts.mcpConfigPaths,
      "--strict-mcp-config",
    )
  }
  if (opts.permissionsAllow && opts.permissionsAllow.length > 0) {
    extraArgs.push(
      "--settings",
      JSON.stringify({ permissions: { allow: opts.permissionsAllow } }),
    )
  }
  if (opts.permissionMode) {
    extraArgs.push("--permission-mode", opts.permissionMode)
  }

  const session = new ClaudeSession({
    cwd: opts.cwd,
    model: opts.model,
    settingSources:
      opts.settingSources === undefined ? "" : opts.settingSources,
    extraArgs,
  })

  const lineEmitter = new EventEmitter()
  const errorHandlers = new Set<(err: Error) => void>()
  let startPromise: Promise<void> | null = null

  const ensureStarted = (): Promise<void> => {
    if (!startPromise) startPromise = session.start()
    return startPromise
  }

  const runTurn = (userMsg: string): void => {
    void (async () => {
      try {
        await ensureStarted()
        const { stopReason, usage } = await session.tailTurn(userMsg, (raw) => {
          lineEmitter.emit("line", raw)
        })
        // Synthesize the `result` line the headless transport would have
        // emitted, so doStream's existing finish branch runs verbatim.
        lineEmitter.emit(
          "line",
          JSON.stringify({
            type: "result",
            subtype: stopReason ?? "end_turn",
            is_error: false,
            session_id: session.sessionId,
            usage: usage ?? {},
            total_cost_usd: null,
            duration_ms: 0,
          }),
        )
        if (!stopReason) {
          // No terminal stop (timeout / process gone): graceful close so
          // doStream emits finish(stop) instead of hanging.
          lineEmitter.emit("close")
        }
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err))
        log.error("interactive turn failed", { error: e.message })
        if (errorHandlers.size > 0) {
          for (const h of errorHandlers) h(e)
        } else {
          lineEmitter.emit("close")
        }
      }
    })()
  }

  // Minimal ChildProcess-shaped shim: only the members doStream/session-manager
  // actually touch (stdin.write, on/off 'error', kill).
  const proc: any = {
    stdin: {
      write(chunk: string): boolean {
        const userMsg =
          typeof chunk === "string" && chunk.endsWith("\n")
            ? chunk.slice(0, -1)
            : chunk
        runTurn(userMsg)
        return true
      },
      end(): void {},
    },
    stdout: null,
    stderr: null,
    pid: -1,
    killed: false,
    on(event: string, fn: (err: Error) => void): unknown {
      if (event === "error") errorHandlers.add(fn)
      return proc
    },
    once(): unknown {
      return proc
    },
    off(event: string, fn: (err: Error) => void): unknown {
      if (event === "error") errorHandlers.delete(fn)
      return proc
    },
    kill(): boolean {
      try {
        session.dispose()
      } catch {}
      proc.killed = true
      return true
    },
  }

  return {
    proc: proc as unknown as ActiveProcess["proc"],
    lineEmitter,
    proxyServer: null,
    mcpHash: undefined,
  }
}
