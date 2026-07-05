import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import * as fs from "node:fs"
import * as path from "node:path"
import * as crypto from "node:crypto"
import { EventEmitter } from "node:events"
import { log } from "./logger.js"
import { pluginTmpDir } from "./tmp.js"

/**
 * Minimal MCP HTTP server embedded in-process. Exposes a set of "proxy"
 * tools (Bash, Edit, Write, etc.) that Claude CLI calls when its built-in
 * equivalents are disabled via --disallowedTools. Our handler blocks until
 * an external broker resolves the call, then responds to Claude.
 *
 * Wire protocol: JSON-RPC 2.0 over plain HTTP POST to `/mcp`. MCP spec
 * also supports SSE streaming, but Claude's HTTP transport accepts single
 * JSON responses for short-lived tool calls, so we keep it simple.
 */

export interface ProxyMcpServer {
  url: string
  serverName: string
  tools: ProxyToolDef[]
  /** Fires when Claude invokes one of our proxy tools. The handler resolves
   * the returned pending call once a result is available. */
  calls: EventEmitter
  /** Write `--mcp-config <path>`-compatible scratch file and return its path. */
  configPath(): string
  close(): Promise<void>
}

export interface ProxyToolDef {
  /** Raw name as seen by Claude once proxied: the MCP exposed tool name. */
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface ProxyToolCall {
  id: string
  toolName: string
  input: Record<string, unknown>
  resolve: (result: ProxyToolResult) => void
  reject: (err: Error) => void
}

export type ProxyToolResult =
  | { kind: "text"; text: string; isError?: boolean }
  | { kind: "error"; message: string }

const PROTOCOL_VERSION = "2024-11-05"
const SERVER_NAME = "opencode_proxy"
export const PROXY_TOOL_PREFIX = `mcp__${SERVER_NAME}__`

// Cap on how long a proxy tool call may wait for opencode to resolve it.
// Matches Claude CLI's hard upper bound for Bash (10 min). Without this the
// HTTP handler waits forever if the broker chain breaks (listener never
// attaches, opencode crashes between turns, etc.) and the Claude
// subprocess sits idle waiting for a tool result that never arrives.
const PROXY_CALL_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Disambiguation appended to the `task` proxy def (both the static
 * fallback and the live overlay). Models routinely resolve opencode's
 * "call the task tool with subagent: X" mention hint to Claude Code's
 * native TaskCreate (a todo tool) — creating a todo, dispatching nothing,
 * and then narrating a successful dispatch. Others burn turns grepping
 * config files to verify a subagent exists before daring to call it.
 * Both failure modes are addressed here, at the tool the model reads.
 */
export const TASK_PROXY_NOTE =
  "This is the ONLY tool that dispatches opencode subagents (including" +
  " user @-mentions). Claude Code's built-in TaskCreate/TaskUpdate manage" +
  " a local todo list and cannot dispatch subagents. Do not search config" +
  " files to verify a subagent type exists — invalid types fail fast with" +
  " a clear error. The call blocks until the subagent finishes; the" +
  " 10-minute proxy timeout applies."

/**
 * Disambiguation appended to the `question` proxy def. Claude Code ships
 * a built-in `AskUserQuestion` that, when proxied, is disabled via
 * `--disallowedTools`; without an explicit hand-off note models keep
 * reaching for the disabled built-in or fall back to plain text. This
 * states that the proxy is the structured-questions path and summarises
 * the answer shape so the model can act on the result without a second
 * round-trip.
 */
export const QUESTION_PROXY_NOTE =
  "This routes structured questions through opencode's native `question`" +
  " tool, which renders a TUI form with the options you provide and" +
  " blocks until the operator answers. Claude Code's built-in" +
  " AskUserQuestion is disabled in this environment; this proxy is the" +
  " ONLY way to ask the operator for a decision or clarification." +
  " Answers come back as arrays of selected labels (set `multiple: true`" +
  " to allow more than one). If the operator dismisses the form the call" +
  " returns an error — treat that as 'no answer' and stop, do not guess." +
  " The 10-minute proxy timeout applies; for long-AFK scenarios prefer" +
  " fewer, high-signal questions."

/**
 * Overlay opencode's live `task` tool description (which includes the
 * "Available agent types" list opencode's registry renders for native
 * models) onto the static proxy def. No-op when the live description is
 * unavailable (SDK client missing, older opencode) or the `task` def is
 * not among the tools.
 */
export function overlayTaskProxyDescription(
  tools: ProxyToolDef[],
  liveDescription: string | undefined,
): ProxyToolDef[] {
  const live = liveDescription?.trim()
  if (!live) return tools
  return tools.map((t) =>
    t.name === "task"
      ? { ...t, description: `${live}\n\n${TASK_PROXY_NOTE}` }
      : t,
  )
}

/**
 * Overlay opencode's live `question` tool description onto the static
 * proxy def, then append the disambiguation note. No-op when the live
 * description is unavailable (older opencode, SDK client missing) — the
 * static def + note stands. Mirrors `overlayTaskProxyDescription`.
 */
export function overlayQuestionProxyDescription(
  tools: ProxyToolDef[],
  liveDescription: string | undefined,
): ProxyToolDef[] {
  const live = liveDescription?.trim()
  if (!live) return tools
  return tools.map((t) =>
    t.name === "question"
      ? { ...t, description: `${live}\n\n${QUESTION_PROXY_NOTE}` }
      : t,
  )
}

/**
 * Version gate for the `question` proxy. opencode added a built-in
 * `question` tool (registry id `question`) — on older builds that entry
 * is absent and a forwarded `mcp__opencode_proxy__question` call would
 * resolve to `⚙ invalid` in opencode. Drop the def silently when the
 * live registry does not contain it so the model never sees a dead tool.
 */
export function filterQuestionProxyByOpencodeSupport(
  tools: ProxyToolDef[],
  opencodeHasQuestion: boolean,
): ProxyToolDef[] {
  if (opencodeHasQuestion) return tools
  return tools.filter((t) => t.name !== "question")
}

export const DEFAULT_PROXY_TOOLS: ProxyToolDef[] = [
  {
    name: "bash",
    description:
      "Execute a shell command. Routed through opencode's bash tool so" +
      " permission prompts flow through opencode's UI.",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
        description: {
          type: "string",
          description: "Short human-readable description of what the command does.",
        },
        timeout: {
          type: "number",
          description: "Optional timeout in milliseconds.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "write",
    description:
      "Write a file. Routed through opencode's write tool so permission prompts flow through opencode's UI.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The file to write. Absolute paths are preferred.",
        },
        content: {
          type: "string",
          description: "The full content to write to the file.",
        },
      },
      required: ["filePath", "content"],
    },
  },
  {
    name: "edit",
    description:
      "Replace text in an existing file. Routed through opencode's edit tool so permission prompts flow through opencode's UI.",
    inputSchema: {
      type: "object",
      properties: {
        filePath: {
          type: "string",
          description: "The file to edit. Absolute paths are preferred.",
        },
        oldString: {
          type: "string",
          description: "The exact text to replace.",
        },
        newString: {
          type: "string",
          description: "The replacement text.",
        },
        replaceAll: {
          type: "boolean",
          description: "Replace all occurrences instead of just the first one.",
        },
      },
      required: ["filePath", "oldString", "newString"],
    },
  },
  {
    name: "webfetch",
    description:
      "Fetch content from a URL. Routed through opencode's webfetch tool so" +
      " permission prompts flow through opencode's UI. Returns the page" +
      " content in the requested format.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The URL to fetch content from. Must start with http:// or https://.",
        },
        format: {
          type: "string",
          enum: ["text", "markdown", "html"],
          description:
            "The format to return the content in. Defaults to markdown.",
        },
        timeout: {
          type: "number",
          description: "Optional timeout in seconds (max 120).",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "task",
    description:
      "Launch an opencode subagent to handle a complex multi-step task" +
      " autonomously. Routed through opencode's task tool so subagent" +
      " orchestration, permission, and lifecycle are handled by opencode." +
      " Use `subagent_type` to pick which configured subagent runs (e.g." +
      " `build`, `general`, `explore`, or any custom subagent declared in" +
      " opencode.json). " +
      TASK_PROXY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "A short (3-5 words) description of the task",
        },
        prompt: {
          type: "string",
          description: "The task for the agent to perform",
        },
        subagent_type: {
          type: "string",
          description: "The type of specialized agent to use for this task",
        },
        task_id: {
          type: "string",
          description:
            "Set this only if you mean to resume a previous task — pass the" +
            " prior task_id to continue the same subagent session instead of" +
            " creating a fresh one.",
        },
        command: {
          type: "string",
          description: "The command that triggered this task",
        },
      },
      required: ["description", "prompt", "subagent_type"],
    },
  },
  {
    name: "question",
    description:
      "Ask the operator structured questions with options and receive" +
      " their answers back. Routed through opencode's native `question`" +
      " tool so the prompt renders as a real TUI form (with options and a" +
      " custom-answer field) instead of a plain text turn. Use this when" +
      " you need a decision, clarification, or preference from the" +
      " operator mid-task. " +
      QUESTION_PROXY_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          description: "Questions to ask.",
          items: {
            type: "object",
            properties: {
              question: {
                type: "string",
                description: "Complete question.",
              },
              header: {
                type: "string",
                description: "Very short label (max 30 chars).",
              },
              options: {
                type: "array",
                description: "Available choices.",
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      description: "Display text (1-5 words, concise).",
                    },
                    description: {
                      type: "string",
                      description: "Explanation of choice.",
                    },
                  },
                  required: ["label", "description"],
                },
              },
              multiple: {
                type: "boolean",
                description:
                  "Allow selecting multiple choices. Defaults to false.",
              },
            },
            required: ["question", "header", "options"],
          },
        },
      },
      required: ["questions"],
    },
  },
]

export async function createProxyMcpServer(
  tools: ProxyToolDef[] = DEFAULT_PROXY_TOOLS,
): Promise<ProxyMcpServer> {
  const calls = new EventEmitter()
  const pending = new Map<string, ProxyToolCall>()

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || !req.url?.startsWith("/mcp")) {
      res.statusCode = 404
      res.end()
      return
    }
    // Hoist the request id and method so the catch block can echo them
    // in error responses. Without this, a broker rejection (timeout /
    // orphan) on a tools/call lands in the catch with no visible id, and
    // the response goes back with `id: null` which Claude CLI cannot
    // match to the original request. The method is also needed because
    // tools/call errors must be returned as MCP results with isError
    // (not JSON-RPC errors) or Claude CLI rejects them as a "malformed
    // result that failed schema validation" (seen live 2026-07-04).
    let requestId: number | string | null = null
    let requestMethod: string | null = null
    try {
      const body = await readBody(req)
      const request = JSON.parse(body) as {
        jsonrpc?: string
        id?: number | string | null
        method?: string
        params?: Record<string, unknown>
      }
      requestId = request?.id ?? null
      requestMethod = typeof request?.method === "string" ? request.method : null

      if (request?.jsonrpc !== "2.0" || typeof request.method !== "string") {
        writeJson(res, {
          jsonrpc: "2.0",
          id: request?.id ?? null,
          error: { code: -32600, message: "Invalid request" },
        })
        return
      }

      log.debug("proxy-mcp request", {
        method: request.method,
        id: request.id,
      })

      if (request.method === "initialize") {
        writeJson(res, {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: {
              name: SERVER_NAME,
              version: "0.1.0",
            },
          },
        })
        return
      }

      if (request.method === "notifications/initialized") {
        res.statusCode = 204
        res.end()
        return
      }

      if (request.method === "tools/list") {
        writeJson(res, {
          jsonrpc: "2.0",
          id: request.id ?? null,
          result: {
            tools: tools.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          },
        })
        return
      }

      if (request.method === "tools/call") {
        const params = request.params ?? {}
        const toolName = String(params.name ?? "")
        const input = (params.arguments ?? {}) as Record<string, unknown>

        if (!tools.some((t) => t.name === toolName)) {
          // Return an MCP result with isError rather than a JSON-RPC
          // error. Claude CLI validates tools/call responses against the
          // MCP result schema and rejects JSON-RPC error envelopes as a
          // "malformed result that failed schema validation".
          writeJson(res, {
            jsonrpc: "2.0",
            id: requestId,
            result: {
              content: [
                { type: "text", text: `Unknown proxy tool: ${toolName}` },
              ],
              isError: true,
            },
          })
          return
        }

        const callId = crypto.randomUUID()
        log.info("proxy-mcp tool call received", {
          callId,
          toolName,
          hasInput: input != null,
        })

        let timer: ReturnType<typeof setTimeout> | null = null
        const result = await new Promise<ProxyToolResult>(
          (resolve, reject) => {
            const entry: ProxyToolCall = {
              id: callId,
              toolName,
              input,
              resolve,
              reject,
            }
            pending.set(callId, entry)
            timer = setTimeout(() => {
              if (!pending.has(callId)) return
              pending.delete(callId)
              // v0.4.13: demoted from warn to notice. Timeouts are usually
              // permission-pending while the user is AFK — surfacing each as
              // a yellow UI bubble produces a wall of noise on return. The
              // file log still captures the event for diagnostics.
              log.notice("proxy-mcp tool call timed out", {
                callId,
                toolName,
                timeoutMs: PROXY_CALL_TIMEOUT_MS,
              })
              reject(
                new Error(
                  `Proxy tool '${toolName}' timed out after ${PROXY_CALL_TIMEOUT_MS}ms waiting for opencode to resolve the call`,
                ),
              )
            }, PROXY_CALL_TIMEOUT_MS)
            calls.emit("call", entry)
          },
        ).finally(() => {
          if (timer) clearTimeout(timer)
          pending.delete(callId)
        })

        // Unify success and error results into one MCP result envelope.
        // A JSON-RPC error for `kind: "error"` was rejected by Claude
        // CLI as a "malformed result that failed schema validation"
        // because tools/call responses are validated as MCP results, so
        // tool-execution errors must surface as `isError: true` instead.
        const text = result.kind === "error" ? result.message : result.text
        const isError = result.kind === "error" || result.isError === true
        writeJson(res, {
          jsonrpc: "2.0",
          id: requestId,
          result: {
            content: [{ type: "text", text }],
            isError,
          },
        })
        return
      }

      writeJson(res, {
        jsonrpc: "2.0",
        id: requestId,
        error: { code: -32601, message: `Unknown method: ${request.method}` },
      })
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      // v0.4.13 + v0.4.19: cleanup rejections from the broker propagate up
      // here. None are user-actionable — they fire on AFK-permission timeouts,
      // orphan-rejections after a turn boundary, stream closes, etc. File-log
      // them at NOTICE; other error shapes stay as WARN so genuine bugs remain
      // visible in the TUI.
      const isExpectedCleanup =
        (errorMessage.includes("timed out after") &&
          errorMessage.includes("waiting for opencode to resolve")) ||
        errorMessage.includes("rejecting as orphaned") ||
        errorMessage.includes("was orphaned by a new user turn")
      const logFn = isExpectedCleanup ? log.notice : log.warn
      logFn("proxy-mcp error handling request", {
        error: errorMessage,
      })
      try {
        // For tools/call, Claude CLI validates the response against the
        // MCP result schema and rejects JSON-RPC error envelopes as a
        // "malformed result that failed schema validation". Broker
        // timeouts and orphan rejections land here via call.reject on a
        // real tools/call, so return an MCP result with isError instead.
        // Other methods (initialize, tools/list) keep the JSON-RPC error
        // shape — those are genuine protocol-level responses.
        if (requestMethod === "tools/call") {
          writeJson(res, {
            jsonrpc: "2.0",
            id: requestId,
            result: {
              content: [{ type: "text", text: errorMessage }],
              isError: true,
            },
          })
        } else {
          writeJson(res, {
            jsonrpc: "2.0",
            id: requestId,
            error: {
              code: -32603,
              message: errorMessage,
            },
          })
        }
      } catch {
        try {
          res.statusCode = 500
          res.end()
        } catch {}
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })

  const addr = server.address() as AddressInfo | null
  if (!addr) {
    server.close()
    throw new Error("Failed to bind proxy MCP server")
  }

  const url = `http://127.0.0.1:${addr.port}/mcp`

  log.info("proxy-mcp server started", {
    url,
    tools: tools.map((t) => t.name),
  })

  let configFilePath: string | null = null

  const api: ProxyMcpServer = {
    url,
    serverName: SERVER_NAME,
    tools,
    calls,
    configPath() {
      if (configFilePath) return configFilePath
      const body = JSON.stringify(
        {
          mcpServers: {
            [SERVER_NAME]: {
              type: "http",
              url,
            },
          },
        },
        null,
        2,
      )
      const hash = crypto
        .createHash("sha256")
        .update(body)
        .digest("hex")
        .slice(0, 12)
      const outPath = path.join(
        pluginTmpDir(),
        `proxy-${hash}.json`,
      )
      fs.writeFileSync(outPath, body, { encoding: "utf8", mode: 0o600 })
      configFilePath = outPath
      return outPath
    },
    async close() {
      for (const entry of pending.values()) {
        entry.reject(new Error("proxy MCP server closed"))
      }
      pending.clear()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
      if (configFilePath) {
        try {
          fs.unlinkSync(configFilePath)
        } catch {}
        configFilePath = null
      }
    },
  }

  return api
}

/** CLI-ready list of Claude tool names to disable, for each proxied tool. */
export function disallowedToolFlags(tools: ProxyToolDef[]): string[] {
  // Map our lowercase MCP tool names to the Claude tool name(s) they replace.
  // `edit` covers both `Edit` and `MultiEdit` because opencode has no
  // MultiEdit equivalent; without disabling MultiEdit, Claude can batch
  // file changes through it and bypass opencode's permission UI.
  // `task` disables Claude CLI's `Agent` tool (its built-in subagent
  // dispatcher) so subagent calls flow through opencode's `task` tool
  // instead — which lets opencode's configured subagent set (`build`,
  // `general`, custom subagents in opencode.json) execute the work
  // under opencode's permission/lifecycle, rather than Claude's
  // internal-only general-purpose / Explore / Plan options.
  const nameMap: Record<string, string[]> = {
    bash: ["Bash"],
    read: ["Read"],
    write: ["Write"],
    edit: ["Edit", "MultiEdit"],
    glob: ["Glob"],
    grep: ["Grep"],
    webfetch: ["WebFetch"],
    task: ["Agent"],
    // `question` disables Claude Code's built-in `AskUserQuestion` so the
    // structured-questions path flows through opencode's native `question`
    // tool instead — same UI/permission/audit benefits as the other
    // proxies. Without this, the model can call both and the two paths
    // diverge (opencode's form vs the headless deny-and-render fallback).
    question: ["AskUserQuestion"],
  }
  const out: string[] = []
  const seen = new Set<string>()
  for (const t of tools) {
    const mapped = nameMap[t.name.toLowerCase()]
    if (!mapped) continue
    for (const claudeTool of mapped) {
      if (seen.has(claudeTool)) continue
      seen.add(claudeTool)
      out.push(claudeTool)
    }
  }
  return out
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

function writeJson(res: ServerResponse, body: unknown): void {
  const payload = JSON.stringify(body)
  res.statusCode = 200
  res.setHeader("Content-Type", "application/json")
  res.setHeader("Content-Length", Buffer.byteLength(payload).toString())
  res.end(payload)
}
