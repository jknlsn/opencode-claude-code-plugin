import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
  SharedV3Warning,
} from "@ai-sdk/provider"
import { generateId } from "@ai-sdk/provider-utils"
import type {
  ClaudeCodeConfig,
  ControlRequestBehavior,
  ClaudeStreamMessage,
  ReasoningEffort,
} from "./types.js"
import { mapTool } from "./tool-mapping.js"
import { getClaudeUserMessage } from "./message-builder.js"
import { bridgeOpencodeMcp, type RuntimeMcpStatus } from "./mcp-bridge.js"
import {
  getRuntimeMcpStatus,
  fetchOpencodeToolList,
} from "./runtime-status.js"
import {
  getActiveProcess,
  spawnClaudeProcess,
  buildCliArgs,
  setClaudeSessionId,
  getClaudeSessionId,
  deleteClaudeSessionId,
  deleteActiveProcess,
  sessionKey,
} from "./session-manager.js"
import { log } from "./logger.js"
import {
  createProxyMcpServer,
  disallowedToolFlags,
  DEFAULT_PROXY_TOOLS,
  PROXY_TOOL_PREFIX,
  type ProxyMcpServer,
  type ProxyToolCall,
  type ProxyToolDef,
  type ProxyToolResult,
} from "./proxy-mcp.js"
import {
  getPendingProxyCalls,
  onPendingProxyCall,
  queuePendingProxyCall,
  rejectAllPendingProxyCallsForSession,
  rejectPendingProxyCallById,
  resolvePendingProxyCallById,
  type PendingProxyCall,
} from "./proxy-broker.js"
import { readFileSync, writeFileSync } from "node:fs"
import { unlink } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"

/**
 * True if the prompt has any user-side content after the last assistant
 * message (text, tool_result, or any user role entry). False when the
 * prompt ends with an assistant message and there is nothing for Claude
 * to respond to — opencode sometimes iterates the agent loop one more
 * time after a turn naturally completed; without short-circuiting we'd
 * spawn Claude CLI on an empty turn and the model would reply with a
 * stub like "Did you mean to send a message?".
 */
export function hasNewUserContent(
  prompt: LanguageModelV3CallOptions["prompt"],
): boolean {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const msg = prompt[i]
    if (msg.role === "assistant") return false
    // Tool-result turns from opencode's outer loop arrive in `tool`-role
    // messages (AI SDK V3 shape). Treat any tool-result part as new
    // content so the short-circuit doesn't drop turns where opencode is
    // delivering the result for a still-pending proxy MCP call — letting
    // that fire `stop` is what was forcing the user to press "continue".
    if (msg.role === "tool") {
      const content: any = msg.content
      if (Array.isArray(content)) {
        for (const part of content as any[]) {
          if (part?.type === "tool-result") return true
        }
      }
      continue
    }
    if (msg.role !== "user") continue
    const content: any = msg.content
    if (typeof content === "string") {
      if (content.trim()) return true
      continue
    }
    if (Array.isArray(content)) {
      for (const part of content as any[]) {
        if (part.type === "text" && part.text && part.text.trim()) return true
        if (part.type === "tool-result") return true
        // Image/file-only user turns count as new input — without this the
        // short-circuit drops them as if the turn were empty.
        if (part.type === "image" || part.type === "file") return true
      }
    }
  }
  return false
}

const AUTO_CONTINUE_MAX_ATTEMPTS = 8
const AUTO_CONTINUE_MAX_ELAPSED_MS = 10 * 60 * 1000
const AUTO_CONTINUE_NO_PROGRESS_LIMIT = 2

const AUTO_CONTINUE_PROMPT =
  "Continue the task from where you stopped. Do not summarize; keep working until the requested task is complete, you need clarification, or you hit a real blocker."

interface AutoContinueState {
  enabled: boolean | "smart" | undefined
  attempts: number
  startedAt: number
  noProgressCount: number
  lastSignature?: string
  aborted?: boolean
}

interface AutoContinueSnapshot {
  text: string
  /**
   * Text of the most recent assistant text block only. Used for final-answer
   * detection so mid-task narration like "Implementing now. Updated the
   * search index." in an earlier block doesn't trip the keyword regex.
   */
  lastVisibleText: string
  hadReasoning: boolean
  hadToolActivity: boolean
  hadProxyActivity: boolean
  isError?: boolean
  now?: number
}

interface AutoContinueDecision {
  continue: boolean
  reason: string
}

function normalizeVisibleText(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function looksLikeQuestion(text: string): boolean {
  const normalized = normalizeVisibleText(text).toLowerCase()
  if (!normalized) return false
  if (normalized.endsWith("?")) return true
  return /\b(please confirm|can you confirm|should i|would you like|do you want|which option|choose|pick one|need your|need you to|what would you like)\b/.test(normalized)
}

function looksLikeBlocker(text: string): boolean {
  const normalized = normalizeVisibleText(text).toLowerCase()
  if (!normalized) return false
  return /\b(blocked|blocker|cannot proceed|can't proceed|unable to proceed|need clarification|need more information|permission denied|failed and needs|requires your|manual step|required from you)\b/.test(normalized)
}

function looksLikeFinalAnswer(text: string): boolean {
  const normalized = normalizeVisibleText(text).toLowerCase()
  if (normalized.length < 40) return false
  if (looksLikeQuestion(normalized) || looksLikeBlocker(normalized)) return false
  return /\b(done|completed|fixed|implemented|verified|published|released|sent|delivered|updated)\b/.test(normalized) ||
    /\b(checks?|tests?) passed\b/.test(normalized) ||
    /\b(summary|what changed|verification)\b/.test(normalized)
}

function continuationSignature(snapshot: AutoContinueSnapshot): string {
  const text = normalizeVisibleText(snapshot.text).slice(-500)
  return JSON.stringify({
    text,
    reasoning: snapshot.hadReasoning,
    tools: snapshot.hadToolActivity,
    proxy: snapshot.hadProxyActivity,
  })
}

export function shouldAutoContinueIncompleteTurn(
  state: AutoContinueState,
  snapshot: AutoContinueSnapshot,
): AutoContinueDecision {
  if (state.enabled === false) return { continue: false, reason: "disabled" }
  if (snapshot.isError) return { continue: false, reason: "error" }
  if (state.aborted) return { continue: false, reason: "aborted" }
  if (state.attempts >= AUTO_CONTINUE_MAX_ATTEMPTS) {
    return { continue: false, reason: "max-attempts" }
  }
  const now = snapshot.now ?? Date.now()
  if (now - state.startedAt > AUTO_CONTINUE_MAX_ELAPSED_MS) {
    return { continue: false, reason: "max-elapsed" }
  }

  const text = normalizeVisibleText(snapshot.text)
  const lastText = normalizeVisibleText(snapshot.lastVisibleText)
  if (looksLikeQuestion(text)) return { continue: false, reason: "question" }
  if (looksLikeBlocker(text)) return { continue: false, reason: "blocker" }
  // Final-answer detection runs on the most recent text block only. Earlier
  // blocks may contain mid-task narration that would false-positive the
  // keyword regex; the model's actual "I'm done" sentence is in the last
  // block before result/end_turn.
  if (looksLikeFinalAnswer(lastText)) {
    return { continue: false, reason: "final-answer" }
  }

  const hadActivity =
    snapshot.hadReasoning || snapshot.hadToolActivity || snapshot.hadProxyActivity
  if (!hadActivity) return { continue: false, reason: "no-activity" }

  const signature = continuationSignature(snapshot)
  const noProgress = signature === state.lastSignature
  if (noProgress && state.noProgressCount + 1 >= AUTO_CONTINUE_NO_PROGRESS_LIMIT) {
    return { continue: false, reason: "no-progress" }
  }

  if (!text) {
    return { continue: true, reason: "activity-without-visible-answer" }
  }

  return { continue: true, reason: "non-final-progress" }
}

function makeAutoContinueMessage(): string {
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text: AUTO_CONTINUE_PROMPT }],
    },
  })
}

function readPromptFileIfPresent(path: string): string | undefined {
  try {
    const content = readFileSync(path, "utf8").trim()
    return content || undefined
  } catch {
    return undefined
  }
}

function nearestWorkspaceAgentsPrompt(cwd: string): string | undefined {
  let dir = cwd
  while (true) {
    const content = readPromptFileIfPresent(join(dir, "AGENTS.md"))
    if (content) return content
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

const MULTI_STEP_TASK_HINT = `## Continuing through multi-step tasks

opencode requires the user to press "continue" after each turn ends. When a
task has multiple steps, do them all in one turn — chain tool calls rather
than pausing for user confirmation between subtasks. End the turn only
when the task is done, you need clarification on intent, or you hit a real
blocker. The user can interrupt or abort at any time; turn endings should
mark meaningful checkpoints, not every completed substep.`

function buildAppendedSystemPrompt(
  cwd: string,
  includeMultiStepHint = true,
): string | undefined {
  const parts: string[] = []
  const configRoot =
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config")
  const globalAgents = readPromptFileIfPresent(join(configRoot, "opencode", "AGENTS.md"))
  const workspaceAgents = nearestWorkspaceAgentsPrompt(cwd)

  if (globalAgents) parts.push(globalAgents)
  if (workspaceAgents && workspaceAgents !== globalAgents) parts.push(workspaceAgents)
  if (includeMultiStepHint) parts.push(MULTI_STEP_TASK_HINT)

  const content = parts.join("\n\n")
  if (!content) return undefined

  const path = join(tmpdir(), `opencode-cc-sys-${randomUUID()}.md`)
  try {
    writeFileSync(path, content, "utf8")
    return path
  } catch (err) {
    log.warn("failed to write system prompt file", { error: String(err) })
    return undefined
  }
}

export class ClaudeCodeLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3"
  readonly modelId: string
  private readonly config: ClaudeCodeConfig

  constructor(modelId: string, config: ClaudeCodeConfig) {
    this.modelId = modelId
    this.config = config
  }

  readonly supportedUrls: Record<string, RegExp[]> = {}

  get provider(): string {
    return this.config.provider
  }

  private toUsage(rawUsage?: ClaudeStreamMessage["usage"]): LanguageModelV3Usage {
    // Prefer the last iteration's counters over cumulative totals.
    // CLI usage is the sum across all internal tool-use iterations;
    // using it directly inflates context size and triggers premature compaction.
    const iter = rawUsage?.iterations
    const effective = iter?.length ? iter[iter.length - 1] : rawUsage
    // Claude CLI reports input_tokens as non-cached input only.
    // OpenCode expects total = noCache + cacheRead + cacheWrite.
    const noCache = effective?.input_tokens ?? 0
    const cacheRead = effective?.cache_read_input_tokens ?? 0
    const cacheWrite = effective?.cache_creation_input_tokens ?? 0
    return {
      inputTokens: {
        total: noCache + cacheRead + cacheWrite,
        noCache,
        cacheRead: cacheRead || undefined,
        cacheWrite: cacheWrite || undefined,
      },
      outputTokens: {
        total: effective?.output_tokens,
        text: effective?.output_tokens,
        reasoning: undefined,
      },
      raw: rawUsage as any,
    }
  }

  private toFinishReason(
    reason: "stop" | "tool-calls" = "stop",
  ): LanguageModelV3FinishReason {
    return {
      unified: reason,
      raw: reason,
    }
  }

  private requestScope(options: { tools?: unknown }): "tools" | "no-tools" {
    const tools = options?.tools
    if (Array.isArray(tools)) return "tools"
    if (tools && typeof tools === "object") {
      return Object.keys(tools as Record<string, unknown>).length > 0
        ? "tools"
        : "no-tools"
    }
    return "no-tools"
  }

  /**
   * Build the combined `--mcp-config` list and return both the list and the
   * hash of the bridged opencode MCP block (or null when bridging is off /
   * yields nothing). The hash is used to detect mid-session config changes
   * and respawn the underlying claude process.
   *
   * `runtimeStatus` is a snapshot of opencode's `client.mcp.status()`. When
   * provided it overlays opencode's UI-toggled state on top of disk config
   * so `/mcps` toggles propagate without a config file write.
   */
  private effectiveMcpConfig(
    cwd: string,
    proxyConfigPath?: string,
    runtimeStatus?: RuntimeMcpStatus,
    excludeServers?: ReadonlySet<string>,
  ): {
    paths: string[]
    bridgedHash: string | null
    allEnabledServerNames: string[]
  } {
    const paths = Array.isArray(this.config.mcpConfig)
      ? this.config.mcpConfig.slice()
      : this.config.mcpConfig
        ? [this.config.mcpConfig]
        : []
    let bridgedHash: string | null = null
    let allEnabledServerNames: string[] = []
    if (this.config.bridgeOpencodeMcp !== false) {
      const bridged = bridgeOpencodeMcp(cwd, runtimeStatus, excludeServers)
      if (bridged) {
        if (bridged.path) paths.push(bridged.path)
        bridgedHash = bridged.hash
        allEnabledServerNames = bridged.allEnabledServerNames
      }
    }
    if (proxyConfigPath) paths.push(proxyConfigPath)
    return { paths, bridgedHash, allEnabledServerNames }
  }

  /** Resolve ProxyToolDef[] for the configured proxyTools names. */
  private resolvedProxyTools(): ProxyToolDef[] | null {
    const names = this.config.proxyTools
    if (!names || names.length === 0) return null
    const defsByName = new Map(
      DEFAULT_PROXY_TOOLS.map((t) => [t.name.toLowerCase(), t]),
    )
    const picked: ProxyToolDef[] = []
    for (const n of names) {
      const def = defsByName.get(String(n).toLowerCase())
      if (def) picked.push(def)
    }
    return picked.length > 0 ? picked : null
  }

  /**
   * Resolve ProxyToolDef[] for opencode's MCP-bridged tools so they go
   * through the in-process proxy instead of being bridged into Claude CLI's
   * `--mcp-config`. Direct bridging causes double execution because both
   * Claude CLI's own MCP child and opencode hold their own connection to
   * the same server; routing through the proxy keeps a single execution
   * site (opencode). Returns null when the feature is disabled, the SDK
   * client is unavailable, or no MCP servers are configured.
   */
  private async resolvedProxyMcpTools(
    allEnabledServerNames: string[],
  ): Promise<ProxyToolDef[] | null> {
    if (this.config.proxyOpencodeMcpTools === false) return null
    if (this.config.bridgeOpencodeMcp === false) return null
    if (allEnabledServerNames.length === 0) return null

    const items = await fetchOpencodeToolList(
      this.config.provider,
      this.modelId,
      this.config.cwd,
    )
    if (!items || items.length === 0) return null

    // opencode names MCP tools `<server>_<originalToolName>`. Match the
    // longest server name prefix first so e.g. `slack_intl_*` resolves to
    // server `slack_intl` not `slack`.
    const serversByLengthDesc = [...allEnabledServerNames].sort(
      (a, b) => b.length - a.length,
    )
    const out: ProxyToolDef[] = []
    const seen = new Set<string>()
    for (const item of items) {
      const matchedServer = serversByLengthDesc.find(
        (name) => item.id === name || item.id.startsWith(`${name}_`),
      )
      if (!matchedServer) continue
      if (seen.has(item.id)) continue
      seen.add(item.id)
      out.push({
        name: item.id,
        description: item.description ?? "",
        inputSchema:
          item.parameters && typeof item.parameters === "object"
            ? item.parameters
            : { type: "object", properties: {} },
      })
    }
    return out.length > 0 ? out : null
  }

  /**
   * Create a proxy MCP server for a single active Claude process/session.
   * The process lifecycle owns the server lifecycle via session-manager.
   */
  private async ensureProxyServer(
    tools: ProxyToolDef[],
    sessionKeyForCalls: string,
  ): Promise<ProxyMcpServer> {
    const srv = await createProxyMcpServer(tools)
    srv.calls.on("call", (call: ProxyToolCall) => {
      queuePendingProxyCall(sessionKeyForCalls, call)
    })
    return srv
  }

  private extractPendingProxyResult(
    prompt: LanguageModelV3CallOptions["prompt"],
    toolCallId: string,
  ): ProxyToolResult | null {
    for (let i = prompt.length - 1; i >= 0; i--) {
      const msg = prompt[i]
      if (msg.role !== "tool" || !Array.isArray(msg.content)) continue

      for (const part of msg.content) {
        if (part.type !== "tool-result" || part.toolCallId !== toolCallId) continue

        const output = part.output as any
        if (!output || typeof output !== "object") {
          return {
            kind: "text",
            text: String(output ?? ""),
          }
        }

        if (output.type === "text") {
          return {
            kind: "text",
            text: String(output.value ?? ""),
          }
        }

        if (output.type === "json") {
          return {
            kind: "text",
            text: JSON.stringify(output.value),
          }
        }

        if (output.type === "content" && Array.isArray(output.value)) {
          const text = output.value
            .filter((v: any) => v?.type === "text" && typeof v.text === "string")
            .map((v: any) => v.text)
            .join("\n")
          return {
            kind: "text",
            text,
          }
        }

        return {
          kind: "text",
          text: JSON.stringify(output),
        }
      }
    }

    return null
  }

  /**
   * Opencode sets `x-session-affinity: <sessionID>` on LLM calls for
   * third-party providers (packages/opencode/src/session/llm.ts). Use it so
   * two chats in the same cwd+model get separate CLI processes instead of
   * stomping on each other. Falls back to "default" when absent (older
   * opencode, direct AI-SDK use, title synthesis paths, etc).
   */
  private sessionAffinity(
    options: LanguageModelV3CallOptions,
  ): string {
    const headers = (options as any)?.headers as
      | Record<string, string | undefined>
      | undefined
    if (!headers) return "default"
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "x-session-affinity") {
        const v = headers[key]
        if (typeof v === "string" && v.length > 0) return v
      }
    }
    return "default"
  }

  private controlRequestBehaviorForTool(toolName: string): ControlRequestBehavior {
    const configured = this.config.controlRequestToolBehaviors
    if (configured && toolName) {
      const direct = configured[toolName] ?? configured[toolName.toLowerCase()]
      if (direct === "allow" || direct === "deny") return direct

      const lower = toolName.toLowerCase()
      for (const [key, behavior] of Object.entries(configured)) {
        if (key.toLowerCase() === lower && (behavior === "allow" || behavior === "deny")) {
          return behavior
        }
      }
    }

    return this.config.controlRequestBehavior ?? "allow"
  }

  private writeControlResponse(
    proc: import("child_process").ChildProcess,
    requestId: string,
    response?: Record<string, unknown>,
  ): void {
    const payload = {
      type: "control_response",
      response: {
        subtype: "success",
        request_id: requestId,
        response,
      },
    }

    try {
      proc.stdin?.write(JSON.stringify(payload) + "\n")
    } catch (error) {
      log.warn("failed to write control response", {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Handle Claude stream-json control requests (`can_use_tool`, etc.) and
   * respond via stdin with a matching `control_response`.
   */
  private handleControlRequest(
    msg: ClaudeStreamMessage,
    proc: import("child_process").ChildProcess,
  ): boolean {
    if (msg.type !== "control_request") return false
    const requestId = msg.request_id
    const request = msg.request
    if (!requestId || !request?.subtype) return false

    if (request.subtype === "can_use_tool") {
      const toolName = request.tool_name ?? "unknown"
      const behavior = this.controlRequestBehaviorForTool(toolName)

      if (behavior === "allow") {
        this.writeControlResponse(proc, requestId, {
          behavior: "allow",
          updatedInput: request.input ?? {},
          toolUseID: request.tool_use_id,
        })
        log.info("control request auto-allowed", {
          requestId,
          toolName,
        })
      } else {
        this.writeControlResponse(proc, requestId, {
          behavior: "deny",
          message:
            this.config.controlRequestDenyMessage ??
            `Denied by opencode-claude-code policy for tool ${toolName}`,
          toolUseID: request.tool_use_id,
        })
        log.info("control request auto-denied", {
          requestId,
          toolName,
        })
      }

      return true
    }

    // For control request subtypes we don't actively handle yet, acknowledge
    // with an empty success so the CLI stream does not stall.
    this.writeControlResponse(proc, requestId, {})
    log.debug("control request acknowledged", {
      requestId,
      subtype: request.subtype,
    })
    return true
  }

  private getReasoningEffort(
    providerOptions?: LanguageModelV3CallOptions["providerOptions"],
  ): ReasoningEffort | undefined {
    if (!providerOptions) return undefined
    const ownKey = this.config.provider
    const bag =
      (providerOptions as any)[ownKey] ??
      (providerOptions as any)["claude-code"]
    const effort = bag?.reasoningEffort
    const valid: ReasoningEffort[] = [
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]
    return valid.includes(effort) ? effort : undefined
  }

  private latestUserText(
    prompt: LanguageModelV3CallOptions["prompt"],
  ): string {
    for (let i = prompt.length - 1; i >= 0; i--) {
      const msg = prompt[i]
      if (msg.role !== "user") continue

      if (typeof msg.content === "string") {
        return String(msg.content).trim()
      }

      if (Array.isArray(msg.content)) {
        const text = (msg.content as any[])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part: any) => String(part.text).trim())
          .filter(Boolean)
          .join(" ")
        if (text) return text
      }
    }

    return ""
  }

  private synthesizeTitle(
    prompt: LanguageModelV3CallOptions["prompt"],
  ): string {
    const source = this.latestUserText(prompt)
      .replace(/\s+/g, " ")
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .trim()

    if (!source) return "New Session"

    const stop = new Set([
      "a",
      "an",
      "the",
      "and",
      "or",
      "but",
      "to",
      "for",
      "of",
      "in",
      "on",
      "at",
      "with",
      "can",
      "could",
      "would",
      "should",
      "please",
      "hi",
      "hello",
      "hey",
      "there",
      "you",
      "your",
      "this",
      "that",
      "is",
      "are",
      "was",
      "were",
      "be",
      "do",
      "does",
      "did",
      "summarize",
      "summary",
      "project",
    ])

    const words = source
      .split(" ")
      .map((word) => word.trim())
      .filter(Boolean)
      .filter((word) => !stop.has(word.toLowerCase()))

    const picked = (words.length > 0 ? words : source.split(" ").filter(Boolean))
      .slice(0, 6)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")

    return picked || "New Session"
  }

  private async doGenerateViaStream(
    options: LanguageModelV3CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV3["doGenerate"]>>> {
    const result = await this.doStream(options)
    const reader = result.stream.getReader()

    let text = ""
    let reasoning = ""
    const toolCalls: LanguageModelV3Content[] = []
    let finishReason = this.toFinishReason("stop")
    let usage: LanguageModelV3Usage = this.toUsage()
    let providerMetadata: any

    while (true) {
      const { value, done } = await reader.read()
      if (done) break

      switch ((value as any).type) {
        case "text-delta":
          text += (value as any).delta ?? ""
          break
        case "reasoning-delta":
          reasoning += (value as any).delta ?? ""
          break
        case "tool-call":
          toolCalls.push({
            type: "tool-call",
            toolCallId: (value as any).toolCallId,
            toolName: (value as any).toolName,
            input: (value as any).input,
            providerExecuted: (value as any).providerExecuted,
          } as any)
          break
        case "finish":
          finishReason = (value as any).finishReason ?? finishReason
          usage = (value as any).usage ?? usage
          providerMetadata = (value as any).providerMetadata ?? providerMetadata
          break
      }
    }

    const content: LanguageModelV3Content[] = []
    if (reasoning) {
      content.push({ type: "reasoning", text: reasoning } as any)
    }
    if (text) {
      content.push({ type: "text", text, providerMetadata } as any)
    }
    content.push(...toolCalls)

    return {
      content,
      finishReason,
      usage,
      request: result.request,
      response: {
        id: generateId(),
        timestamp: new Date(),
        modelId: this.modelId,
      },
      providerMetadata,
      warnings: [],
    }
  }

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV3["doGenerate"]>>> {
    const warnings: SharedV3Warning[] = []
    const cwd = this.config.cwd ?? process.cwd()
    const scope = this.requestScope(options as any)
    const affinity = this.sessionAffinity(options)
    const sk = sessionKey(cwd, `${this.modelId}::${scope}::${affinity}`)

    // When selective proxying is enabled, doGenerate must not bypass the
    // proxy path. Reuse doStream and aggregate its events so proxied tools
    // still route through opencode permissions/execution. Same for
    // opencode MCP proxying — doStream is the only path that wires up the
    // proxy server with the dynamically-discovered MCP tool defs.
    if (
      scope === "tools" &&
      (this.resolvedProxyTools() ||
        (this.config.proxyOpencodeMcpTools !== false &&
          this.config.bridgeOpencodeMcp !== false))
    ) {
      return this.doGenerateViaStream(options)
    }

    if (scope === "no-tools") {
      const text = this.synthesizeTitle(options.prompt)
      return {
        content: [{ type: "text", text }] as any,
        finishReason: this.toFinishReason("stop"),
        usage: this.toUsage({ input_tokens: 0, output_tokens: 0 }),
        request: { body: { text: "" } },
        response: {
          id: generateId(),
          timestamp: new Date(),
          modelId: this.modelId,
        },
        providerMetadata: {
          "claude-code": {
            synthetic: true,
            path: "no-tools",
          },
        },
        warnings,
      }
    }

    // Short-circuit when opencode iterates the agent loop one more time
    // after a turn already finished. The prompt ends with an assistant
    // message and has no fresh user input — spawning Claude here would
    // just produce a stub like "No input received. Standing by".
    if (!hasNewUserContent(options.prompt)) {
      log.info("doGenerate short-circuit: no new user content")
      return {
        content: [],
        finishReason: this.toFinishReason("stop"),
        usage: this.toUsage({ input_tokens: 0, output_tokens: 0 }),
        request: { body: { text: "" } },
        response: {
          id: generateId(),
          timestamp: new Date(),
          modelId: this.modelId,
        },
        providerMetadata: {
          "claude-code": { synthetic: true, path: "no-new-user-content" },
        },
        warnings,
      }
    }

    const hasPriorConversation =
      options.prompt.filter((m) => m.role === "user" || m.role === "assistant")
        .length > 1

    // New session — clear any stale state from a previous session
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk)
      deleteActiveProcess(sk)
    }

    const hasExistingSession = !!getClaudeSessionId(sk)
    const includeHistoryContext = !hasExistingSession && hasPriorConversation

    const reasoningEffort = this.getReasoningEffort(options.providerOptions)
    const userMsg = getClaudeUserMessage(
      options.prompt,
      includeHistoryContext,
      reasoningEffort,
    )

    // doGenerate always spawns a fresh process, never reuse session ID.
    // Pre-fetch opencode's MCP runtime status so the bridge overlays
    // UI-toggled state on top of disk config.
    const runtimeStatus = await getRuntimeMcpStatus()
    const systemPromptFile = buildAppendedSystemPrompt(
      cwd,
      this.config.multiStepContinuation !== false,
    )
    const cliArgs = buildCliArgs({
      sessionKey: sk,
      skipPermissions: this.config.skipPermissions !== false,
      includeSessionId: false,
      model: this.modelId,
      permissionMode: this.config.permissionMode,
      mcpConfig: this.effectiveMcpConfig(cwd, undefined, runtimeStatus).paths,
      strictMcpConfig: this.config.strictMcpConfig,
      disallowedTools:
        this.config.webSearch === "disabled" ? ["WebSearch"] : undefined,
      appendSystemPromptFile: systemPromptFile,
    })

    log.info("doGenerate starting", {
      cwd,
      model: this.modelId,
      textLength: userMsg.length,
      includeHistoryContext,
    })

    const { spawn } = await import("node:child_process")
    const { createInterface } = await import("node:readline")

    const proc = spawn(this.config.cliPath, cliArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color" },
      shell: process.platform === "win32",
    })

    if (systemPromptFile) {
      proc.on("exit", () => {
        void unlink(systemPromptFile).catch(() => {})
      })
    }

    const rl = createInterface({ input: proc.stdout! })

    let responseText = ""
    let thinkingText = ""
    let resultMeta: {
      sessionId?: string
      costUsd?: number
      durationMs?: number
      usage?: ClaudeStreamMessage["usage"]
    } = {}
    const toolCalls: Array<{ id: string; name: string; args: unknown }> = []

    // Set true once we observe a `stream_event` envelope. When on, the
    // top-level `assistant` message is a duplicate of content already
    // accumulated via the inner content_block_* events — skip it.
    let gotPartialEvents = false

    const result = await new Promise<
      typeof resultMeta & {
        text: string
        thinking: string
        toolCalls: typeof toolCalls
      }
    >((resolve, reject) => {
      rl.on("line", (line) => {
        if (!line.trim()) return
        try {
          const outer: ClaudeStreamMessage = JSON.parse(line)

          // Unwrap stream_event envelope (--include-partial-messages).
          // Inner event uses the same content_block_* / message_* shape.
          const msg: ClaudeStreamMessage =
            outer.type === "stream_event" && outer.event
              ? { ...outer.event, session_id: outer.session_id }
              : outer

          if (outer.type === "stream_event") {
            gotPartialEvents = true
          }

          if (this.handleControlRequest(msg, proc)) {
            return
          }

          if (msg.type === "system" && msg.subtype === "init") {
            if (msg.session_id) {
              setClaudeSessionId(sk, msg.session_id)
            }
          }

          if (
            msg.type === "assistant" &&
            msg.message?.content &&
            !gotPartialEvents
          ) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) {
                responseText += block.text
              }
              if (block.type === "thinking" && block.thinking) {
                thinkingText += block.thinking
              }
              if (block.type === "tool_use" && block.id && block.name) {
                if (
                  block.name === "AskUserQuestion" ||
                  block.name === "ask_user_question"
                ) {
                  // Emit question as text
                  const parsedInput = (block.input ?? {}) as Record<
                    string,
                    unknown
                  >
                  const question =
                    (parsedInput?.question as string) || "Question?"
                  responseText += `\n\n_Asking: ${question}_\n\n`
                  continue
                }

                if (block.name === "ExitPlanMode") {
                  const parsedInput = (block.input ?? {}) as Record<
                    string,
                    unknown
                  >
                  const plan = (parsedInput?.plan as string) || ""
                  responseText += `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`
                  continue
                }

                toolCalls.push({
                  id: block.id,
                  name: block.name,
                  args: block.input ?? {},
                })
              }
            }
          }

          if (msg.type === "content_block_start" && msg.content_block) {
            if (
              msg.content_block.type === "tool_use" &&
              msg.content_block.id &&
              msg.content_block.name
            ) {
              toolCalls.push({
                id: msg.content_block.id,
                name: msg.content_block.name,
                args: {},
              })
            }
          }

          if (msg.type === "content_block_delta" && msg.delta) {
            if (msg.delta.type === "text_delta" && msg.delta.text) {
              responseText += msg.delta.text
            }
            if (msg.delta.type === "thinking_delta" && msg.delta.thinking) {
              thinkingText += msg.delta.thinking
            }
            if (
              msg.delta.type === "input_json_delta" &&
              msg.delta.partial_json &&
              msg.index !== undefined
            ) {
              const tc = toolCalls[msg.index]
              if (tc) {
                try {
                  tc.args = JSON.parse(msg.delta.partial_json)
                } catch {
                  // Partial JSON, accumulate
                }
              }
            }
          }

          if (msg.type === "result") {
            if (msg.session_id) {
              setClaudeSessionId(sk, msg.session_id)
            }

            // Some CLI failures only surface user-readable text on the final
            // `result` message (without prior assistant text blocks). Preserve
            // that so callers don't receive an empty response.
            if (
              !responseText &&
              msg.is_error &&
              typeof msg.result === "string" &&
              msg.result.trim().length > 0
            ) {
              responseText = msg.result
            }

            resultMeta = {
              sessionId: msg.session_id,
              costUsd: msg.total_cost_usd,
              durationMs: msg.duration_ms,
              usage: msg.usage,
            }
            resolve({
              ...resultMeta,
              text: responseText,
              thinking: thinkingText,
              toolCalls,
            })
          }
        } catch {
          // Ignore non-JSON lines
        }
      })

      rl.on("close", () => {
        resolve({
          ...resultMeta,
          text: responseText,
          thinking: thinkingText,
          toolCalls,
        })
      })

      proc.on("error", (err) => {
        log.error("process error", { error: err.message })
        reject(err)
      })

      proc.stderr?.on("data", (data: Buffer) => {
        log.debug("stderr", { data: data.toString().slice(0, 200) })
      })

      proc.stdin?.write(userMsg + "\n")
    })

    const content: LanguageModelV3Content[] = []

    if (result.thinking) {
      content.push({
        type: "reasoning",
        text: result.thinking,
      } as any)
    }

    if (result.text) {
      content.push({
        type: "text",
        text: result.text,
        providerMetadata: {
          "claude-code": {
            sessionId: result.sessionId ?? null,
            costUsd: result.costUsd ?? null,
            durationMs: result.durationMs ?? null,
          },
          ...(typeof result.usage?.cache_creation_input_tokens === "number"
            ? {
                anthropic: {
                  cacheCreationInputTokens:
                    result.usage.cache_creation_input_tokens,
                },
              }
            : {}),
        },
      })
    }

    for (const tc of result.toolCalls) {
      const {
        name: mappedName,
        input: mappedInput,
        executed,
        skip,
      } = mapTool(tc.name, tc.args, { webSearch: this.config.webSearch })
      if (skip) continue
      content.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: mappedName,
        input: JSON.stringify(mappedInput),
        providerExecuted: executed,
      } as any)
    }

    const usage = this.toUsage(result.usage)

    return {
      content,
      // Claude CLI's `result` message signals a fully-completed turn —
      // tools have already been executed internally and final assistant
      // text has been produced. Always report "stop" so opencode doesn't
      // loop expecting to run tools itself.
      finishReason: this.toFinishReason("stop"),
      usage,
      request: { body: { text: userMsg } },
      response: {
        id: result.sessionId ?? generateId(),
        timestamp: new Date(),
        modelId: this.modelId,
      },
      providerMetadata: {
        "claude-code": {
          sessionId: result.sessionId ?? null,
          costUsd: result.costUsd ?? null,
          durationMs: result.durationMs ?? null,
        },
        ...(typeof result.usage?.cache_creation_input_tokens === "number"
          ? {
              anthropic: {
                cacheCreationInputTokens:
                  result.usage.cache_creation_input_tokens,
              },
            }
          : {}),
      },
      warnings,
    }
  }

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<Awaited<ReturnType<LanguageModelV3["doStream"]>>> {
    const warnings: SharedV3Warning[] = []
    const cwd = this.config.cwd ?? process.cwd()
    const cliPath = this.config.cliPath
    const skipPermissions = this.config.skipPermissions !== false
    const scope = this.requestScope(options as any)
    const affinity = this.sessionAffinity(options)
    const sk = sessionKey(cwd, `${this.modelId}::${scope}::${affinity}`)
    const toUsage = this.toUsage.bind(this)
    const toFinishReason = this.toFinishReason.bind(this)
    const handleControlRequest = this.handleControlRequest.bind(this)

    if (scope === "no-tools") {
      const text = this.synthesizeTitle(options.prompt)
      const textId = generateId()
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings })
          controller.enqueue({ type: "text-start", id: textId } as any)
          controller.enqueue({
            type: "text-delta",
            id: textId,
            delta: text,
          })
          controller.enqueue({ type: "text-end", id: textId })
          controller.enqueue({
            type: "finish",
            finishReason: toFinishReason("stop"),
            usage: toUsage({ input_tokens: 0, output_tokens: 0 }),
            providerMetadata: {
              "claude-code": {
                synthetic: true,
                path: "no-tools",
              },
            },
          })
          controller.close()
        },
      })

      return {
        stream,
        request: { body: { text: "" } },
      }
    }

    // Short-circuit when opencode iterates the agent loop one more time
    // after a turn already finished. The prompt ends with an assistant
    // message and has no fresh user input — spawning Claude here would
    // just produce a stub like "No input received. Standing by".
    if (!hasNewUserContent(options.prompt)) {
      log.info("doStream short-circuit: no new user content")
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings })
          controller.enqueue({
            type: "finish",
            finishReason: toFinishReason("stop"),
            usage: toUsage({ input_tokens: 0, output_tokens: 0 }),
            providerMetadata: {
              "claude-code": { synthetic: true, path: "no-new-user-content" },
            },
          })
          controller.close()
        },
      })
      return { stream, request: { body: { text: "" } } }
    }

    const hasPriorConversation =
      options.prompt.filter((m) => m.role === "user" || m.role === "assistant")
        .length > 1

    // New session — clear any stale state from a previous session
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk)
      deleteActiveProcess(sk)
    }

    const hasExistingSession = !!getClaudeSessionId(sk)
    const hasActiveProcess = !!getActiveProcess(sk)
    const includeHistoryContext =
      !hasExistingSession && !hasActiveProcess && hasPriorConversation

    const reasoningEffort = this.getReasoningEffort(options.providerOptions)
    const userMsg = getClaudeUserMessage(
      options.prompt,
      includeHistoryContext,
      reasoningEffort,
    )
    const resolvedProxy = this.resolvedProxyTools()
    const self = this

    const previousPendingProxyCalls = getPendingProxyCalls(sk)
    const previousPendingProxyMatches: Array<{
      call: PendingProxyCall
      result: ProxyToolResult | null
    }> = previousPendingProxyCalls.map((call) => ({
      call,
      result: this.extractPendingProxyResult(options.prompt, call.toolCallId),
    }))
    const hasMatchedPendingResults = previousPendingProxyMatches.some(
      (m) => m.result !== null,
    )

    // Pre-fetch opencode's MCP runtime status before constructing the
    // ReadableStream so the sync hot-reload check and async setup() see
    // the same overlay snapshot. One in-process call per turn — cheap;
    // the SDK client routes through `Server.app.fetch` (no socket).
    const runtimeStatus = await getRuntimeMcpStatus()

    log.info("doStream starting", {
      cwd,
      model: this.modelId,
      textLength: userMsg.length,
      includeHistoryContext,
      hasActiveProcess,
      reasoningEffort,
      proxyTools: resolvedProxy?.map((t) => t.name) ?? null,
    })

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start(controller) {
        let activeProcess = getActiveProcess(sk)
        let proc: import("child_process").ChildProcess
        let lineEmitter: import("events").EventEmitter
        let proxyServer: ProxyMcpServer | null = activeProcess?.proxyServer ?? null

        // Hot reload: evict cached subprocess if the bridged opencode MCP
        // config has drifted since spawn. Only checked between turns (here,
        // before setup() runs), never mid tool-call. The stored claude
        // session id is preserved so the respawn resumes the conversation
        // via `--session-id` (handled by buildCliArgs).
        if (
          activeProcess &&
          self.config.hotReloadMcp !== false &&
          self.config.bridgeOpencodeMcp !== false
        ) {
          const probe = self.effectiveMcpConfig(cwd, undefined, runtimeStatus)
          const previousHash = activeProcess.mcpHash ?? null
          if (previousHash !== probe.bridgedHash) {
            log.info("opencode MCP config changed, respawning claude", {
              sk,
              previousHash,
              currentHash: probe.bridgedHash,
            })
            deleteActiveProcess(sk)
            activeProcess = undefined
            proxyServer = null
          }
        }

        const setup = async () => {
          // First pass: discover which opencode MCP servers would be bridged.
          // We use this to decide which ones to re-route through the proxy
          // instead. No --mcp-config path is consumed here; it's recomputed
          // below with the exclusion set in place.
          const discovery = self.effectiveMcpConfig(
            cwd,
            undefined,
            runtimeStatus,
          )

          // Fetch the proxy MCP tools (one ProxyToolDef per opencode MCP-
          // bridged tool). If discovery returns nothing or the SDK is
          // unreachable, this is null and we fall back to direct bridging.
          const proxyMcpTools = await self.resolvedProxyMcpTools(
            discovery.allEnabledServerNames,
          )
          const excludeServers: ReadonlySet<string> | undefined = proxyMcpTools
            ? new Set(discovery.allEnabledServerNames)
            : undefined

          const combinedProxyTools: ProxyToolDef[] | null =
            resolvedProxy || proxyMcpTools
              ? [...(resolvedProxy ?? []), ...(proxyMcpTools ?? [])]
              : null

          if (!proxyServer && combinedProxyTools) {
            proxyServer = await self.ensureProxyServer(combinedProxyTools, sk)
          }

          const proxyDisallowed = resolvedProxy ? disallowedToolFlags(resolvedProxy) : []
          const extraDisallowed: string[] = []
          if (self.config.webSearch === "disabled") extraDisallowed.push("WebSearch")
          const allDisallowed = [...proxyDisallowed, ...extraDisallowed]
          const mcp = self.effectiveMcpConfig(
            cwd,
            proxyServer?.configPath(),
            runtimeStatus,
            excludeServers,
          )
          const systemPromptFile = activeProcess
            ? undefined
            : buildAppendedSystemPrompt(
                cwd,
                self.config.multiStepContinuation !== false,
              )
          const cliArgs = buildCliArgs({
            sessionKey: sk,
            skipPermissions,
            model: self.modelId,
            permissionMode: self.config.permissionMode,
            mcpConfig: mcp.paths,
            strictMcpConfig: self.config.strictMcpConfig,
            disallowedTools: allDisallowed.length > 0 ? allDisallowed : undefined,
            appendSystemPromptFile: systemPromptFile,
          })

          if (activeProcess) {
            proc = activeProcess.proc
            lineEmitter = activeProcess.lineEmitter
            log.debug("reusing active process", { sk })
          } else {
            const ap = spawnClaudeProcess(
              cliPath,
              cliArgs,
              cwd,
              sk,
              proxyServer,
              mcp.bridgedHash,
              systemPromptFile,
            )
            proc = ap.proc
            lineEmitter = ap.lineEmitter
            activeProcess = ap
          }

          controller.enqueue({ type: "stream-start", warnings })

          let currentTextId: string | null = null
          const textBlockIndices = new Set<number>()

          const startTextBlock = (): string => {
            if (currentTextId) {
              controller.enqueue({ type: "text-end", id: currentTextId })
            }
            const id = generateId()
            currentTextId = id
            controller.enqueue({ type: "text-start", id } as any)
            return id
          }

          const endTextBlock = (): void => {
            if (currentTextId) {
              controller.enqueue({ type: "text-end", id: currentTextId })
              currentTextId = null
            }
          }

          const reasoningIds = new Map<number, string>()
          const reasoningStarted = new Map<number, boolean>()

          let turnCompleted = false
          let controllerClosed = false
          let pendingProxyUnsubscribe: (() => void) | null = null
          let resultFallbackTimer: ReturnType<typeof setTimeout> | null = null
          let hasReceivedContent = false
          let visibleTextSinceContinue = ""
          let lastVisibleTextSinceContinue = ""
          let hadReasoningSinceContinue = false
          let hadToolActivitySinceContinue = false
          let hadProxyActivitySinceContinue = false
          const autoContinueState: AutoContinueState = {
            enabled: self.config.autoContinueIncompleteTurns,
            attempts: 0,
            startedAt: Date.now(),
            noProgressCount: 0,
          }

          const clearFallbackTimer = () => {
            if (resultFallbackTimer) {
              clearTimeout(resultFallbackTimer)
              resultFallbackTimer = null
            }
          }

          // Wire-inactivity watchdog. Resets on every line received from the
          // CLI; only fires if the CLI has emitted content and then gone
          // silent on stdout for `delayMs` without sending a `result`. The
          // previous design armed this on every text content_block_stop,
          // which killed legitimate mid-turn think pauses (most visibly
          // with sonnet between text-end and the next tool_use_start).
          const startResultFallback = (delayMs = 60_000) => {
            clearFallbackTimer()
            if (!hasReceivedContent || controllerClosed) return
            resultFallbackTimer = setTimeout(() => {
              if (controllerClosed) return
              log.warn("result fallback timer fired — closing stream without result event", {
                delayMs,
              })
              closeHandler()
            }, delayMs)
          }

          const toolCallMap = new Map<
            number,
            { id: string; name: string; inputJson: string }
          >()
          // Tool calls the plugin reported as providerExecuted:false — opencode
          // will run these itself and emit its own tool-result, so we must NOT
          // forward Claude CLI's tool_result for them (would short-circuit
          // opencode's execute).
          const skipResultForIds = new Set<string>()
          const toolCallsById = new Map<
            string,
            { id: string; name: string; input: unknown }
          >()

          let resultMeta: {
            sessionId?: string
            costUsd?: number
            durationMs?: number
            usage?: ClaudeStreamMessage["usage"]
          } = {}

        // Batched drain so claude CLI's parallel tool_use blocks (e.g. two
        // bash calls in one assistant message) end up in a single
        // tool-calls finish event. Without this, the broker would reject
        // every overlapping call and claude would see spurious tool errors.
        const drainBuffer: PendingProxyCall[] = []
        let drainTimer: ReturnType<typeof setTimeout> | null = null
        const DRAIN_QUIET_MS = 100

        const finishWithToolCalls = (calls: PendingProxyCall[]) => {
          if (controllerClosed) return
          if (calls.length === 0) return
          for (const call of calls) {
            controller.enqueue({
              type: "tool-input-start",
              id: call.toolCallId,
              toolName: call.toolName,
            } as any)
            controller.enqueue({
              type: "tool-call",
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              input: JSON.stringify(call.input),
              providerExecuted: false,
            } as any)
            skipResultForIds.add(call.toolCallId)
          }
          controller.enqueue({
            type: "finish",
            finishReason: toFinishReason("tool-calls"),
            usage: toUsage(resultMeta.usage),
            providerMetadata: {
              "claude-code": resultMeta,
            },
          })
          controllerClosed = true
          cleanupTurn()
          try {
            controller.close()
          } catch {}
        }

        const drainNow = () => {
          if (drainTimer) {
            clearTimeout(drainTimer)
            drainTimer = null
          }
          if (drainBuffer.length === 0) return
          if (controllerClosed) return
          const batch = drainBuffer.splice(0, drainBuffer.length)
          log.info("draining pending proxy calls into stream finish", {
            sessionKey: sk,
            count: batch.length,
            toolCallIds: batch.map((c) => c.toolCallId),
          })
          finishWithToolCalls(batch)
        }

        const noteVisibleText = (text: string) => {
          visibleTextSinceContinue += text
          lastVisibleTextSinceContinue += text
        }

        const resetLastVisibleTextBlock = () => {
          lastVisibleTextSinceContinue = ""
        }

        const noteReasoning = () => {
          hadReasoningSinceContinue = true
        }

        const noteToolActivity = () => {
          hadToolActivitySinceContinue = true
        }

        const noteProxyActivity = () => {
          hadProxyActivitySinceContinue = true
        }

        const resetAutoContinueWindow = () => {
          visibleTextSinceContinue = ""
          lastVisibleTextSinceContinue = ""
          hadReasoningSinceContinue = false
          hadToolActivitySinceContinue = false
          hadProxyActivitySinceContinue = false
        }

        // Set true once we observe a `stream_event` envelope. When on, the
        // top-level `assistant` message is a duplicate of what we already
        // streamed via content_block_* deltas — skip its content.
        let gotPartialEvents = false

        const lineHandler = (line: string) => {
          if (!line.trim()) return
          if (controllerClosed) return

          // Any line from the CLI counts as activity — reset the inactivity
          // watchdog so mid-turn pauses between blocks don't get killed.
          startResultFallback()

          try {
            const outer: ClaudeStreamMessage = JSON.parse(line)

            // Unwrap stream_event envelope (--include-partial-messages).
            // Inner event uses the same content_block_* / message_* shape.
            const msg: ClaudeStreamMessage =
              outer.type === "stream_event" && outer.event
                ? { ...outer.event, session_id: outer.session_id }
                : outer

            if (outer.type === "stream_event") {
              gotPartialEvents = true
            }

            if (handleControlRequest(msg, proc)) {
              return
            }

            log.debug("stream message", {
              type: msg.type,
              subtype: msg.subtype,
            })

            // Handle system init
            if (msg.type === "system" && msg.subtype === "init") {
              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id)
                log.info("session initialized", {
                  claudeSessionId: msg.session_id,
                })
              }
            }

            // content_block_start
            if (
              msg.type === "content_block_start" &&
              msg.content_block &&
              msg.index !== undefined
            ) {
              const block = msg.content_block
              const idx = msg.index

              if (block.type === "thinking") {
                noteReasoning()
                const reasoningId = generateId()
                reasoningIds.set(idx, reasoningId)
                controller.enqueue({
                  type: "reasoning-start",
                  id: reasoningId,
                } as any)
                reasoningStarted.set(idx, true)
              }

              if (block.type === "text") {
                textBlockIndices.add(idx)
                // New text block — clear last-block buffer so final-answer
                // detection only considers this block's contents, not earlier
                // mid-task narration.
                resetLastVisibleTextBlock()
                if (block.text) {
                  if (!currentTextId) startTextBlock()
                  controller.enqueue({
                    type: "text-delta",
                    id: currentTextId!,
                    delta: block.text,
                  })
                  noteVisibleText(block.text)
                  hasReceivedContent = true
                }
              }

              if (block.type === "tool_use" && block.id && block.name) {
                noteToolActivity()
                toolCallMap.set(idx, {
                  id: block.id,
                  name: block.name,
                  inputJson: "",
                })

                if (
                  block.name !== "AskUserQuestion" &&
                  block.name !== "ask_user_question" &&
                  block.name !== "ExitPlanMode" &&
                  !block.name.startsWith(PROXY_TOOL_PREFIX)
                ) {
                  const { name: mappedName, skip, executed } = mapTool(
                    block.name,
                    undefined,
                    { webSearch: self.config.webSearch },
                  )
                  if (!skip) {
                    controller.enqueue({
                      type: "tool-input-start",
                      id: block.id,
                      toolName: mappedName,
                      providerExecuted: executed,
                    } as any)
                    log.info("tool started", {
                      name: block.name,
                      mappedName,
                      id: block.id,
                    })
                  }
                }
              }
            }

            // content_block_delta
            if (
              msg.type === "content_block_delta" &&
              msg.delta &&
              msg.index !== undefined
            ) {
              const delta = msg.delta
              const idx = msg.index

              if (delta.type === "thinking_delta" && delta.thinking) {
                noteReasoning()
                const reasoningId = reasoningIds.get(idx)
                if (reasoningId) {
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: reasoningId,
                    delta: delta.thinking,
                  } as any)
                }
              }

              if (delta.type === "text_delta" && delta.text) {
                if (!currentTextId) startTextBlock()
                controller.enqueue({
                  type: "text-delta",
                  id: currentTextId!,
                  delta: delta.text,
                })
                noteVisibleText(delta.text)
                hasReceivedContent = true
              }

              if (delta.type === "input_json_delta" && delta.partial_json) {
                const tc = toolCallMap.get(idx)
                if (tc) {
                  tc.inputJson += delta.partial_json
                  controller.enqueue({
                    type: "tool-input-delta",
                    id: tc.id,
                    delta: delta.partial_json,
                  } as any)
                }
              }
            }

            // content_block_stop
            if (
              msg.type === "content_block_stop" &&
              msg.index !== undefined
            ) {
              const idx = msg.index

              const reasoningId = reasoningIds.get(idx)
              if (reasoningId && reasoningStarted.get(idx)) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: reasoningId,
                } as any)
                reasoningStarted.delete(idx)
              }

              if (textBlockIndices.has(idx)) {
                endTextBlock()
                textBlockIndices.delete(idx)
              }

              const tc = toolCallMap.get(idx)
              if (tc) {
                let parsedInput: any = {}
                try {
                  parsedInput = JSON.parse(tc.inputJson || "{}")
                } catch {}

                if (
                  tc.name === "AskUserQuestion" ||
                  tc.name === "ask_user_question"
                ) {
                  let question = "Question?"
                  if (
                    parsedInput?.questions &&
                    Array.isArray(parsedInput.questions) &&
                    parsedInput.questions.length > 0
                  ) {
                    question =
                      parsedInput.questions[0].question ||
                      parsedInput.questions[0].text ||
                      "Question?"
                  } else {
                    question =
                      parsedInput?.question ||
                      parsedInput?.text ||
                      "Question?"
                  }

                  const askId = startTextBlock()
                  controller.enqueue({
                    type: "text-delta",
                    id: askId,
                    delta: `\n\n_Asking: ${question}_\n\n`,
                  })
                  endTextBlock()
                } else if (tc.name === "ExitPlanMode") {
                  const plan = (parsedInput?.plan as string) || ""

                  const planId = startTextBlock()
                  controller.enqueue({
                    type: "text-delta",
                    id: planId,
                    delta: `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`,
                  })
                  endTextBlock()
                } else if (tc.name.startsWith(PROXY_TOOL_PREFIX)) {
                  log.debug("ignoring proxy tool_use block; broker handles it", {
                    name: tc.name,
                    id: tc.id,
                  })
                } else {
                  const {
                    name: mappedName,
                    input: mappedInput,
                    executed,
                    skip,
                  } = mapTool(tc.name, parsedInput, { webSearch: self.config.webSearch })

                  if (!skip) {
                    toolCallsById.set(tc.id, {
                      id: tc.id,
                      name: tc.name,
                      input: parsedInput,
                    })
                    if (!executed) skipResultForIds.add(tc.id)

                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: tc.id,
                      toolName: mappedName,
                      input: JSON.stringify(mappedInput),
                      providerExecuted: executed,
                    } as any)
                  }
                  log.info("tool call complete", {
                    name: tc.name,
                    mappedName,
                    id: tc.id,
                    executed,
                  })
                }
              }
            }

            // assistant message (complete, not streaming).
            // When --include-partial-messages is on, this is a duplicate of
            // what we already streamed via content_block_* events. Skip it.
            if (
              msg.type === "assistant" &&
              msg.message?.content &&
              !gotPartialEvents
            ) {
              const hasText = msg.message.content.some(
                (b: any) => b.type === "text" && b.text,
              )
              const hasToolUse = msg.message.content.some(
                (b: any) => b.type === "tool_use",
              )

              if (hasText) {
                hasReceivedContent = true
              }

              if (hasText && !hasToolUse) {
                startResultFallback()
              }
              if (hasToolUse) {
                clearFallbackTimer()
              }

              for (const block of msg.message.content) {
                if (block.type === "text" && block.text) {
                  // New text block — keep only this block's text in the
                  // last-block buffer for final-answer detection.
                  resetLastVisibleTextBlock()
                  const blockId = startTextBlock()
                  controller.enqueue({
                    type: "text-delta",
                    id: blockId,
                    delta: block.text,
                  })
                  endTextBlock()
                  noteVisibleText(block.text)
                  hasReceivedContent = true
                }

                if (block.type === "thinking" && block.thinking) {
                  noteReasoning()
                  const thinkingId = generateId()
                  controller.enqueue({
                    type: "reasoning-start",
                    id: thinkingId,
                  } as any)
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: thinkingId,
                    delta: block.thinking,
                  } as any)
                  controller.enqueue({
                    type: "reasoning-end",
                    id: thinkingId,
                  } as any)
                }

                if (block.type === "tool_use" && block.id && block.name) {
                  noteToolActivity()
                  const parsedInput = (block.input ?? {}) as Record<
                    string,
                    unknown
                  >
                  toolCallsById.set(block.id, {
                    id: block.id,
                    name: block.name,
                    input: parsedInput,
                  })

                  if (
                    block.name === "AskUserQuestion" ||
                    block.name === "ask_user_question"
                  ) {
                    let question = "Question?"
                    if (
                      parsedInput?.questions &&
                      Array.isArray(parsedInput.questions) &&
                      parsedInput.questions.length > 0
                    ) {
                      const q = parsedInput.questions[0] as any
                      question = q.question || q.text || "Question?"
                    } else {
                      question =
                        (parsedInput?.question as string) ||
                        (parsedInput?.text as string) ||
                        "Question?"
                    }

                    const askId = startTextBlock()
                    controller.enqueue({
                      type: "text-delta",
                      id: askId,
                      delta: `\n\n_Asking: ${question}_\n\n`,
                    })
                    endTextBlock()
                  } else if (block.name === "ExitPlanMode") {
                    const plan = (parsedInput?.plan as string) || ""

                    const planId = startTextBlock()
                    controller.enqueue({
                      type: "text-delta",
                      id: planId,
                      delta: `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`,
                    })
                    endTextBlock()
                  } else if (block.name.startsWith(PROXY_TOOL_PREFIX)) {
                    log.debug("ignoring proxy tool_use from assistant message", {
                      name: block.name,
                      id: block.id,
                    })
                  } else {
                    const {
                      name: mappedName,
                      input: mappedInput,
                      executed,
                      skip,
                    } = mapTool(block.name, parsedInput, { webSearch: self.config.webSearch })

                    if (!skip) {
                      if (!executed) skipResultForIds.add(block.id)
                      controller.enqueue({
                        type: "tool-input-start",
                        id: block.id,
                        toolName: mappedName,
                        providerExecuted: executed,
                      } as any)
                      controller.enqueue({
                        type: "tool-call",
                        toolCallId: block.id,
                        toolName: mappedName,
                        input: JSON.stringify(mappedInput),
                        providerExecuted: executed,
                      } as any)
                    }
                    log.info("tool_use from assistant message", {
                      name: block.name,
                      mappedName,
                      id: block.id,
                      executed,
                    })
                  }
                }

                if (block.type === "tool_result") {
                  log.debug("tool_result", {
                    toolUseId: block.tool_use_id,
                  })
                }
              }
            }

            // user message (tool results from Claude CLI)
            if (msg.type === "user" && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "tool_result" && block.tool_use_id) {
                  if (skipResultForIds.has(block.tool_use_id)) {
                    log.debug("skipping tool-result (opencode runs it)", {
                      toolUseId: block.tool_use_id,
                    })
                    continue
                  }
                  const toolCall = toolCallsById.get(block.tool_use_id)
                  if (toolCall) {
                    let resultText = ""
                    if (typeof block.content === "string") {
                      resultText = block.content
                    } else if (Array.isArray(block.content)) {
                      resultText = block.content
                        .filter(
                          (
                            c,
                          ): c is { type: string; text: string } =>
                            c.type === "text" &&
                            typeof c.text === "string",
                        )
                        .map((c) => c.text)
                        .join("\n")
                    }

                    controller.enqueue({
                      type: "tool-result",
                      toolCallId: block.tool_use_id,
                      toolName: toolCall.name,
                      result: {
                        output: resultText,
                        title: toolCall.name,
                        metadata: {},
                      },
                      providerExecuted: true,
                    } as any)
                    noteToolActivity()
                    log.info("tool result emitted", {
                      toolUseId: block.tool_use_id,
                      name: toolCall.name,
                    })
                    toolCallsById.delete(block.tool_use_id)
                  }
                }
              }
            }

            // result - end of conversation turn
            if (msg.type === "result") {
              clearFallbackTimer()

              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id)
              }

              // Some CLI failures only include user-readable text in
              // `result.result` (no prior assistant text blocks). Emit it so
              // opencode users don't see a blank turn.
              if (
                !currentTextId &&
                msg.is_error &&
                typeof msg.result === "string" &&
                msg.result.trim().length > 0
              ) {
                const errId = startTextBlock()
                controller.enqueue({
                  type: "text-delta",
                  id: errId,
                  delta: msg.result,
                })
              }

              resultMeta = {
                sessionId: msg.session_id,
                costUsd: msg.total_cost_usd,
                durationMs: msg.duration_ms,
                usage: msg.usage,
              }

              log.info("conversation result", {
                sessionId: msg.session_id,
                durationMs: msg.duration_ms,
                numTurns: msg.num_turns,
                isError: msg.is_error,
              })

              turnCompleted = true

              endTextBlock()

              // Drain race / abandoned-call guard. If Claude CLI emitted
              // `result` while a proxy tool call is still pending — either
              // because the 100ms drain timer hasn't fired yet, or because
              // Claude CLI gave up on its MCP HTTP request after an internal
              // timeout — drain it through the normal tool-calls flow so
              // opencode executes the tool; otherwise reject any orphan
              // pending calls so proxy-mcp returns to the HTTP caller
              // immediately instead of hanging until the broker's 10-minute
              // timeout (which surfaces as a hard 2-minute "operation timed
              // out" on the SDK side).
              if (drainBuffer.length > 0) {
                log.info(
                  "draining pending proxy calls at turn-result boundary",
                  {
                    sessionKey: sk,
                    count: drainBuffer.length,
                  },
                )
                drainNow()
                return
              }
              const orphanPending = getPendingProxyCalls(sk)
              if (orphanPending.length > 0) {
                log.warn(
                  "rejecting orphan pending proxy calls at turn-result boundary",
                  {
                    sessionKey: sk,
                    count: orphanPending.length,
                  },
                )
                rejectAllPendingProxyCallsForSession(
                  sk,
                  new Error(
                    "Claude CLI emitted result with pending proxy calls not in drain buffer",
                  ),
                )
              }

              const autoDecision = shouldAutoContinueIncompleteTurn(
                autoContinueState,
                {
                  text: visibleTextSinceContinue,
                  lastVisibleText: lastVisibleTextSinceContinue,
                  hadReasoning: hadReasoningSinceContinue,
                  hadToolActivity: hadToolActivitySinceContinue,
                  hadProxyActivity: hadProxyActivitySinceContinue,
                  isError: msg.is_error,
                },
              )
              if (autoDecision.continue) {
                const signature = continuationSignature({
                  text: visibleTextSinceContinue,
                  lastVisibleText: lastVisibleTextSinceContinue,
                  hadReasoning: hadReasoningSinceContinue,
                  hadToolActivity: hadToolActivitySinceContinue,
                  hadProxyActivity: hadProxyActivitySinceContinue,
                  isError: msg.is_error,
                })
                autoContinueState.noProgressCount =
                  signature === autoContinueState.lastSignature
                    ? autoContinueState.noProgressCount + 1
                    : 0
                autoContinueState.lastSignature = signature
                autoContinueState.attempts++
                log.notice("auto-continuing incomplete claude result", {
                  sessionKey: sk,
                  reason: autoDecision.reason,
                  attempts: autoContinueState.attempts,
                  textLength: visibleTextSinceContinue.length,
                  lastTextLength: lastVisibleTextSinceContinue.length,
                  hadReasoning: hadReasoningSinceContinue,
                  hadToolActivity: hadToolActivitySinceContinue,
                  hadProxyActivity: hadProxyActivitySinceContinue,
                })
                turnCompleted = false
                resetAutoContinueWindow()
                proc.stdin?.write(makeAutoContinueMessage() + "\n")
                return
              }
              log.notice("auto-continuation stopped", {
                sessionKey: sk,
                reason: autoDecision.reason,
                attempts: autoContinueState.attempts,
                textLength: visibleTextSinceContinue.length,
                lastTextLength: lastVisibleTextSinceContinue.length,
                hadReasoning: hadReasoningSinceContinue,
                hadToolActivity: hadToolActivitySinceContinue,
                hadProxyActivity: hadProxyActivitySinceContinue,
              })

              for (const [idx, reasoningId] of reasoningIds) {
                if (reasoningStarted.get(idx)) {
                  controller.enqueue({
                    type: "reasoning-end",
                    id: reasoningId,
                  } as any)
                }
              }

              controller.enqueue({
                type: "finish",
                finishReason: toFinishReason("stop"),
                usage: toUsage(msg.usage),
                providerMetadata: {
                  "claude-code": resultMeta,
                  ...(typeof msg.usage?.cache_creation_input_tokens === "number"
                    ? {
                        anthropic: {
                          cacheCreationInputTokens:
                            msg.usage.cache_creation_input_tokens,
                        },
                      }
                    : {}),
                },
              })

              controllerClosed = true
              cleanupTurn()

              try {
                controller.close()
              } catch {}
            }
          } catch (e) {
            log.debug("failed to parse line", {
              error:
                e instanceof Error ? e.message : String(e),
            })
          }
        }

        const closeHandler = () => {
          log.debug("readline closed")
          if (controllerClosed) return
          // Claude CLI's stdio is gone. The proxy-mcp HTTP requests that
          // backed any pending tool calls have no one to answer them now —
          // reject so the handlers return errors rather than hang.
          if (drainBuffer.length > 0 || getPendingProxyCalls(sk).length > 0) {
            rejectAllPendingProxyCallsForSession(
              sk,
              new Error(
                "Claude CLI subprocess closed before pending tool calls were resolved",
              ),
            )
            drainBuffer.length = 0
          }
          controllerClosed = true
          cleanupTurn()
          endTextBlock()
          controller.enqueue({
            type: "finish",
            finishReason: toFinishReason("stop"),
            usage: toUsage(),
            providerMetadata: {
              "claude-code": resultMeta,
            },
          })
          try {
            controller.close()
          } catch {}
        }

        // Centralised per-turn teardown. Every exit path funnels through here
        // so we don't accumulate listeners across turns on a reused process.
        let cleanedUp = false
        const cleanupTurn = () => {
          if (cleanedUp) return
          cleanedUp = true
          clearFallbackTimer()
          if (drainTimer) {
            clearTimeout(drainTimer)
            drainTimer = null
          }
          lineEmitter.off("line", lineHandler)
          lineEmitter.off("close", closeHandler)
          pendingProxyUnsubscribe?.()
          pendingProxyUnsubscribe = null
          proc.off("error", procErrorHandler)
        }

        const procErrorHandler = (err: Error) => {
          log.error("process error", { error: err.message })
          if (controllerClosed) return
          // Subprocess failure invalidates every pending HTTP-bound tool
          // call for this session. Reject them so proxy-mcp returns errors
          // to Claude rather than letting the sockets stall.
          if (drainBuffer.length > 0 || getPendingProxyCalls(sk).length > 0) {
            rejectAllPendingProxyCallsForSession(
              sk,
              new Error(
                `Claude CLI subprocess error: ${err.message}`,
              ),
            )
            drainBuffer.length = 0
          }
          controllerClosed = true
          cleanupTurn()
          controller.enqueue({ type: "error", error: err })
          try {
            controller.close()
          } catch {}
        }

        lineEmitter.on("line", lineHandler)
        lineEmitter.on("close", closeHandler)

        pendingProxyUnsubscribe = onPendingProxyCall(sk, (call) => {
          if (controllerClosed) {
            // Stream already closed (we already drained). Late arrival —
            // reject immediately so the proxy-mcp HTTP request returns
            // instead of hanging until its 10-min timeout.
            log.warn(
              "pending proxy call arrived after stream close; rejecting",
              {
                sessionKey: sk,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
              },
            )
            rejectPendingProxyCallById(
              call.toolCallId,
              new Error(
                `Pending proxy call '${call.toolName}' arrived after the stream was already closed`,
              ),
            )
            return
          }
          log.info("received pending proxy call for session", {
            sessionKey: sk,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
          })
          noteProxyActivity()
          noteToolActivity()
          drainBuffer.push(call)
          if (drainTimer) clearTimeout(drainTimer)
          drainTimer = setTimeout(drainNow, DRAIN_QUIET_MS)
        })

        proc.on("error", procErrorHandler)

        // On abort, keep process alive for next message
        if (options.abortSignal) {
          options.abortSignal.addEventListener("abort", () => {
            autoContinueState.aborted = true
            if (turnCompleted || controllerClosed) return

            if (!hasReceivedContent) {
              log.info(
                "abort signal received before content, closing stream immediately",
                { cwd },
              )
              controllerClosed = true
              cleanupTurn()
              try {
                controller.close()
              } catch {}
              return
            }

            log.info(
              "abort signal received mid-turn, starting grace period",
              { cwd },
            )
            // Abort grace period — short, since the user already asked to stop.
            startResultFallback(5_000)
          })
        }

        if (hasMatchedPendingResults) {
          // Tool-result turn: the prompt carries opencode's results for the
          // proxy tool calls we drained on the previous turn. Resolve each
          // matched call (claude CLI's HTTP handlers wake up and continue).
          // Any pending calls without a matching tool-result are orphans
          // (rare protocol anomaly); reject them so claude CLI doesn't hang
          // on those HTTP requests.
          for (const { call, result } of previousPendingProxyMatches) {
            if (result) {
              log.info("resolving pending proxy call from tool result prompt", {
                sessionKey: sk,
                toolCallId: call.toolCallId,
                toolName: call.toolName,
              })
              resolvePendingProxyCallById(call.toolCallId, result)
            } else {
              log.warn(
                "pending proxy call had no matching tool-result; rejecting as orphan",
                {
                  sessionKey: sk,
                  toolCallId: call.toolCallId,
                  toolName: call.toolName,
                },
              )
              rejectPendingProxyCallById(
                call.toolCallId,
                new Error(
                  `Pending proxy call '${call.toolName}' (${call.toolCallId}) was not matched in tool-result turn; rejecting as orphaned`,
                ),
              )
            }
          }
          return
        }

        // No pending calls had matching tool-results. If any pending calls
        // are still hanging around from a prior turn, reject them so the
        // HTTP handlers in proxy-mcp don't sit blocked forever while we
        // proceed with a brand new user message.
        if (previousPendingProxyCalls.length > 0) {
          for (const call of previousPendingProxyCalls) {
            rejectPendingProxyCallById(
              call.toolCallId,
              new Error(
                `Pending proxy call '${call.toolName}' (${call.toolCallId}) was orphaned by a new user turn; rejecting`,
              ),
            )
          }
        }

        // Send the user message for a fresh turn.
        proc.stdin?.write(userMsg + "\n")
        log.debug("sent user message", { textLength: userMsg.length })
        }

        void setup().catch((err) => {
          log.error("failed to set up doStream", {
            error: err instanceof Error ? err.message : String(err),
          })
          controller.enqueue({
            type: "error",
            error: err instanceof Error ? err : new Error(String(err)),
          })
          try {
            controller.close()
          } catch {}
        })
      },
      cancel() {
        // Consumer cancelled the stream
      },
    })

    return {
      stream,
      request: { body: { text: userMsg } },
      response: { headers: {} },
    }
  }
}
