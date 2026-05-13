export interface ClaudeCodeConfig {
  provider: string
  cliPath: string
  cwd?: string
  account?: string
  configDir?: string
  providerID?: string
  skipPermissions?: boolean
  permissionMode?: PermissionMode
  mcpConfig?: string | string[]
  strictMcpConfig?: boolean
  bridgeOpencodeMcp?: boolean
  controlRequestBehavior?: ControlRequestBehavior
  controlRequestToolBehaviors?: Record<string, ControlRequestBehavior>
  controlRequestDenyMessage?: string
  proxyTools?: string[]
  webSearch?: WebSearchRouting
  hotReloadMcp?: boolean
  proxyOpencodeMcpTools?: boolean
}

export type WebSearchRouting = "claude" | "disabled" | (string & {})

export interface ClaudeCodeProviderSettings {
  cliPath?: string
  cwd?: string
  name?: string
  providerID?: string
  account?: string
  configDir?: string
  accounts?: string[]
  skipPermissions?: boolean
  permissionMode?: PermissionMode
  mcpConfig?: string | string[]
  strictMcpConfig?: boolean
  /**
   * Auto-translate opencode's `mcp` config block (from opencode.json/jsonc
   * discovered via cwd/OPENCODE_CONFIG/XDG) into a Claude CLI `--mcp-config`
   * file and pass it through on spawn. Defaults to `true` so the CLI sees
   * the same MCP servers opencode is configured with.
   */
  bridgeOpencodeMcp?: boolean
  /**
   * Behavior for Claude CLI `control_request` permission checks
   * (`subtype: can_use_tool`) when `skipPermissions` is false.
   *
   * - allow: approve tool use requests automatically.
   * - deny: reject tool use requests automatically.
   *
   * Defaults to `allow`.
   */
  controlRequestBehavior?: ControlRequestBehavior

  /**
   * Optional per-tool overrides for control-request behavior.
   * Keys are Claude tool names (eg. `Bash`, `Read`, `mcp__github__list_prs`) and
   * values are `allow` or `deny`.
   */
  controlRequestToolBehaviors?: Record<string, ControlRequestBehavior>

  /**
   * Custom deny message sent back to Claude CLI when behavior resolves to deny.
   */
  controlRequestDenyMessage?: string

  /**
   * Proxy these Claude built-in tools through opencode instead of letting the
   * CLI execute them directly. When a tool is listed here, the plugin:
   *   - passes `--disallowedTools <ClaudeName>` to the CLI, and
   *   - exposes an equivalent tool via an in-process HTTP MCP server named
   *     `opencode_proxy`. Claude calls the MCP tool, which blocks on
   *     opencode's tool executor (with its native permission UI) and returns
   *     the result.
   *
   * Supported: `bash`, `write`, `edit`, `webfetch`. Leave empty or unset to disable proxying.
   */
  proxyTools?: string[]

  /**
   * Routing for Claude's built-in `WebSearch` tool.
   *
   * - `"claude"` (default): Claude CLI runs WebSearch internally via
   *   Anthropic's web search. No MCP setup required, no extra cost.
   * - `"<opencode-tool-name>"` (e.g. `"websearch_web_search_exa"`): forward
   *   the call to that opencode-side tool with `executed:false`. Requires
   *   the corresponding MCP server to be configured in opencode.
   * - `"disabled"`: prevent the model from calling WebSearch entirely
   *   (passes `WebSearch` via `--disallowedTools`).
   */
  webSearch?: WebSearchRouting

  /**
   * Detect mid-session opencode MCP config changes and respawn the
   * underlying claude process so newly enabled / disabled MCPs become
   * visible to the model without restarting opencode or starting a new
   * chat. Eviction happens at the start of the next user turn (never mid
   * tool-call) and `--session-id` is preserved so the conversation
   * continues seamlessly. Defaults to `true`.
   *
   * Set to `false` to keep the previous behavior (cached subprocess
   * survives MCP changes until the chat is reset).
   */
  hotReloadMcp?: boolean

  /**
   * Route opencode MCP server tools through the in-process `opencode_proxy`
   * MCP server instead of bridging them directly into Claude CLI's
   * `--mcp-config`. With both layers configured for the same MCP server,
   * direct bridging causes each tool invocation to execute twice — once by
   * Claude CLI's own MCP child process and once by opencode. Routing through
   * the proxy keeps a single execution site (opencode) while preserving the
   * tool-call/result surface in opencode's UI and its permission prompts.
   *
   * Defaults to `true`. Set to `false` to restore the prior direct-bridge
   * behavior (Claude CLI executes MCP tools itself; opencode also re-executes
   * — accept the duplication if you need Claude to invoke the tool without
   * an opencode round-trip).
   */
  proxyOpencodeMcpTools?: boolean
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max"

export type PermissionMode =
  | "acceptEdits"
  | "auto"
  | "bypassPermissions"
  | "default"
  | "dontAsk"
  | "plan"

export type ControlRequestBehavior = "allow" | "deny"

export interface ClaudeCodeCallOptions {
  reasoningEffort?: ReasoningEffort
}

/**
 * Claude CLI stream-json message types.
 */
export interface ClaudeStreamMessage {
  type: string
  subtype?: string
  request_id?: string

  // Present on `stream_event` envelopes when --include-partial-messages is on.
  // The inner event mirrors the same shape (content_block_*, message_*, etc).
  event?: ClaudeStreamMessage

  request?: {
    subtype?: string
    tool_name?: string
    input?: Record<string, unknown>
    tool_use_id?: string
    permission_suggestions?: unknown[]
    blocked_path?: string
    decision_reason?: string
    title?: string
    display_name?: string
    agent_id?: string
    description?: string
  }

  message?: {
    role?: string
    model?: string
    content?: Array<{
      type: string
      text?: string
      name?: string
      input?: unknown
      id?: string
      tool_use_id?: string
      content?: string | Array<{ type: string; text?: string }>
      thinking?: string
    }>
  }

  tool?: {
    name?: string
    id?: string
    input?: unknown
  }

  tool_result?: {
    tool_use_id?: string
    content?: string | Array<{ type: string; text?: string }>
    is_error?: boolean
  }

  session_id?: string
  total_cost_usd?: number
  duration_ms?: number
  duration_api_ms?: number
  id?: string
  result?: string
  is_error?: boolean
  num_turns?: number

  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    iterations?: Array<{
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }>
  }

  content_block?: {
    type: string
    text?: string
    id?: string
    name?: string
    input?: string
    thinking?: string
  }

  delta?: {
    type: string
    text?: string
    partial_json?: string
    thinking?: string
  }

  index?: number
}
