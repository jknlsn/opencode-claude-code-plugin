import type { RuntimeMcpStatus } from "./mcp-bridge.js"
import { log } from "./logger.js"

/**
 * Captured opencode SDK client from `PluginInput`. Lives in its own module
 * to break the cycle that would otherwise form between `index.ts` and
 * `claude-code-language-model.ts`. `null` until the plugin's `server`
 * factory runs (e.g. early provider lookups, direct AI-SDK use, tests).
 */
type OpencodeClient = {
  mcp?: {
    status?: () => Promise<{ data?: unknown; error?: unknown }>
  }
  tool?: {
    list?: (options: {
      query: { provider: string; model: string; directory?: string }
    }) => Promise<{ data?: unknown; error?: unknown }>
  }
}

let opencodeClient: OpencodeClient | null = null

export function setOpencodeClient(client: unknown): void {
  if (client && typeof client === "object") {
    opencodeClient = client as OpencodeClient
  }
}

/**
 * Snapshot opencode's current MCP runtime status so the bridge can overlay
 * UI-toggled state on top of disk config. Returns `undefined` on any
 * failure (no client captured, status call rejected, malformed response)
 * so the bridge falls back to disk-only.
 */
export async function getRuntimeMcpStatus(): Promise<
  RuntimeMcpStatus | undefined
> {
  const client = opencodeClient
  if (!client?.mcp?.status) return undefined
  try {
    const res = await client.mcp.status()
    const data = (res as { data?: unknown }).data
    if (!data || typeof data !== "object") return undefined
    const out: RuntimeMcpStatus = {}
    for (const [name, entry] of Object.entries(data as Record<string, unknown>)) {
      if (entry && typeof entry === "object") {
        const status = (entry as { status?: unknown }).status
        if (typeof status === "string") out[name] = status
      }
    }
    return out
  } catch (err) {
    log.warn("failed to fetch opencode MCP runtime status", {
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}

export interface OpencodeToolListItem {
  id: string
  description: string
  parameters: Record<string, unknown>
}

/**
 * Fetch opencode's full tool catalog (built-ins + MCP-bridged) with JSON
 * Schema parameters via `client.tool.list()`. The provider/model query
 * narrows the schema variants opencode returns; in practice MCP-origin
 * tool schemas are model-agnostic, so any registered (provider, model)
 * works as the query target. Returns `undefined` on any failure so callers
 * can fall back to direct-bridge behavior.
 */
export async function fetchOpencodeToolList(
  provider: string,
  model: string,
  directory?: string,
): Promise<OpencodeToolListItem[] | undefined> {
  const client = opencodeClient
  if (!client?.tool?.list) return undefined
  try {
    const res = await client.tool.list({
      query: { provider, model, ...(directory ? { directory } : {}) },
    })
    const data = (res as { data?: unknown }).data
    if (!Array.isArray(data)) return undefined
    const out: OpencodeToolListItem[] = []
    for (const entry of data as unknown[]) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as Record<string, unknown>
      const id = typeof e.id === "string" ? e.id : null
      const description =
        typeof e.description === "string" ? e.description : ""
      const parameters =
        e.parameters && typeof e.parameters === "object"
          ? (e.parameters as Record<string, unknown>)
          : {}
      if (!id) continue
      out.push({ id, description, parameters })
    }
    return out
  } catch (err) {
    log.warn("failed to fetch opencode tool list", {
      provider,
      model,
      error: err instanceof Error ? err.message : String(err),
    })
    return undefined
  }
}
