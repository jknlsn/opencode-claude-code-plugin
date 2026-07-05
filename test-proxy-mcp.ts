/**
 * Integration tests for src/proxy-mcp.ts — the in-process MCP HTTP server.
 *
 * These stand up a real `createProxyMcpServer` on an ephemeral port and
 * drive it over plain HTTP, so they exercise the actual JSON-RPC framing
 * (including the catch-block error envelope).
 *
 * Usage:
 *   npx tsx --test test-proxy-mcp.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import * as http from "node:http"
import {
  createProxyMcpServer,
  buildProxyTimeoutError,
  resolveProxyCallTimeoutMs,
  DEFAULT_PROXY_TOOLS,
  PROXY_DEFAULT_TIMEOUT_MS,
  MAX_PROXY_TIMEOUT_MS,
  type ProxyMcpServer,
  type ProxyToolCall,
  type ProxyToolResult,
} from "./src/proxy-mcp.js"

function post(url: string, body: unknown): Promise<{
  status: number
  json: any
}> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on("data", (c: Buffer) => chunks.push(c))
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8")
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) })
          } catch {
            resolve({ status: res.statusCode ?? 0, json: text })
          }
        })
      },
    )
    req.on("error", reject)
    req.write(payload)
    req.end()
  })
}

async function withServer<T>(
  fn: (srv: ProxyMcpServer) => Promise<T>,
): Promise<T> {
  const srv = await createProxyMcpServer(DEFAULT_PROXY_TOOLS)
  try {
    return await fn(srv)
  } finally {
    await srv.close()
  }
}

// Regression for the 2026-07-04 "malformed result that failed schema
// validation" bug: Claude CLI validates tools/call responses against the
// MCP result schema and rejects JSON-RPC error envelopes. Every tools/call
// error path (broker rejection, error result, unknown tool) must return
// an MCP result with `isError: true`, and must echo the request id.
test("tools/call broker rejection returns an MCP result with isError, echoing the id", async () => {
  await withServer(async (srv) => {
    // Reject every incoming call immediately, simulating a broker
    // rejection (the same path a 10-min timeout takes).
    srv.calls.on("call", (call: ProxyToolCall) => {
      call.reject(new Error("simulated broker rejection"))
    })

    const res = await post(srv.url, {
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "bash", arguments: { command: "echo hi" } },
    })

    assert.equal(res.status, 200)
    assert.equal(res.json.jsonrpc, "2.0")
    assert.equal(res.json.id, 42, "response must echo the request id")
    assert.equal(res.json.error, undefined, "must not be a JSON-RPC error envelope")
    assert.ok(res.json.result, "expected an MCP result envelope")
    assert.equal(res.json.result.isError, true)
    assert.match(
      res.json.result.content[0].text,
      /simulated broker rejection/,
    )
  })
})

test("tools/call with kind:error result returns an MCP result with isError", async () => {
  await withServer(async (srv) => {
    srv.calls.on("call", (call: ProxyToolCall) => {
      const result: ProxyToolResult = {
        kind: "error",
        message: "opencode tool execution failed",
      }
      call.resolve(result)
    })

    const res = await post(srv.url, {
      jsonrpc: "2.0",
      id: "req-7",
      method: "tools/call",
      params: { name: "bash", arguments: {} },
    })

    assert.equal(res.json.id, "req-7")
    assert.equal(res.json.error, undefined)
    assert.equal(res.json.result.isError, true)
    assert.match(
      res.json.result.content[0].text,
      /opencode tool execution failed/,
    )
  })
})

test("tools/call for an unknown tool returns an MCP result with isError", async () => {
  await withServer(async (srv) => {
    const res = await post(srv.url, {
      jsonrpc: "2.0",
      id: 99,
      method: "tools/call",
      params: { name: "nonexistent_tool", arguments: {} },
    })
    assert.equal(res.json.id, 99)
    assert.equal(res.json.error, undefined)
    assert.equal(res.json.result.isError, true)
    assert.match(res.json.result.content[0].text, /Unknown proxy tool/)
  })
})

test("tools/call success preserves isError:false and the result text", async () => {
  await withServer(async (srv) => {
    srv.calls.on("call", (call: ProxyToolCall) => {
      call.resolve({ kind: "text", text: "done" })
    })
    const res = await post(srv.url, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "bash", arguments: {} },
    })
    assert.equal(res.json.result.isError, false)
    assert.equal(res.json.result.content[0].text, "done")
  })
})

test("malformed JSON still responds (with null id when unparseable)", async () => {
  await withServer(async (srv) => {
    // Send invalid JSON so parsing throws before requestId is set.
    const res = await new Promise<{
      status: number
      json: any
    }>((resolve, reject) => {
      const req = http.request(
        srv.url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength("{not json").toString(),
          },
        },
        (r) => {
          const chunks: Buffer[] = []
          r.on("data", (c: Buffer) => chunks.push(c))
          r.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8")
            try {
              resolve({ status: r.statusCode ?? 0, json: JSON.parse(text) })
            } catch {
              resolve({ status: r.statusCode ?? 0, json: text })
            }
          })
        },
      )
      req.on("error", reject)
      req.write("{not json")
      req.end()
    })

    // When the body never parsed, null id is the only honest answer and
    // is correct JSON-RPC (no request id was ever seen).
    assert.equal(res.json.id, null)
    assert.ok(res.json.error)
  })
})

test("tools/list exposes the question proxy def", async () => {
  await withServer(async (srv) => {
    const res = await post(srv.url, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })
    const names = res.json.result.tools.map((t: any) => t.name)
    assert.ok(names.includes("question"))
    assert.ok(names.includes("task"))
    assert.ok(names.includes("bash"))
  })
})

// --- per-tool proxy timeouts ------------------------------------------------

const MIN = 60 * 1000

test("resolveProxyCallTimeoutMs: unknown tool uses the flat 10-min default", () => {
  assert.equal(
    resolveProxyCallTimeoutMs("edit", undefined, undefined),
    PROXY_DEFAULT_TIMEOUT_MS,
  )
})

test("resolveProxyCallTimeoutMs: task defaults to 60 min, question to 30 min", () => {
  assert.equal(resolveProxyCallTimeoutMs("task", undefined, undefined), 60 * MIN)
  assert.equal(
    resolveProxyCallTimeoutMs("question", undefined, undefined),
    30 * MIN,
  )
})

test("resolveProxyCallTimeoutMs: user override replaces the default", () => {
  assert.equal(
    resolveProxyCallTimeoutMs("task", undefined, { task: 5 * MIN }),
    5 * MIN,
  )
})

test("resolveProxyCallTimeoutMs: override key is case-insensitive", () => {
  // Users configure proxyTools with capitalised names ("Task", "Bash"); the
  // override map must match regardless of case.
  assert.equal(
    resolveProxyCallTimeoutMs("task", undefined, { Task: 7 * MIN }),
    7 * MIN,
  )
  assert.equal(
    resolveProxyCallTimeoutMs("bash", undefined, { Bash: 9 * MIN }),
    9 * MIN,
  )
})

test("resolveProxyCallTimeoutMs: bash input.timeout only ever raises", () => {
  // The bash proxy def advertises a `timeout` field; the proxy must not
  // undercut a build the caller explicitly asked to run long.
  assert.equal(
    resolveProxyCallTimeoutMs("bash", { timeout: 25 * MIN }, undefined),
    25 * MIN,
  )
  // A smaller input.timeout never lowers the resolved deadline.
  assert.equal(
    resolveProxyCallTimeoutMs("bash", { timeout: 1000 }, { bash: 5 * MIN }),
    5 * MIN,
  )
  // And it raises above an override too.
  assert.equal(
    resolveProxyCallTimeoutMs("bash", { timeout: 12 * MIN }, { bash: 5 * MIN }),
    12 * MIN,
  )
})

test("resolveProxyCallTimeoutMs: invalid overrides are ignored", () => {
  // 0 / negative / NaN must not replace the default — a misformed config
  // entry should never collapse the deadline.
  assert.equal(
    resolveProxyCallTimeoutMs("task", undefined, { task: 0 }),
    60 * MIN,
  )
  assert.equal(
    resolveProxyCallTimeoutMs("task", undefined, { task: -100 }),
    60 * MIN,
  )
  assert.equal(
    resolveProxyCallTimeoutMs("task", undefined, { task: NaN as any }),
    60 * MIN,
  )
})

test("resolveProxyCallTimeoutMs: absurd values are clamped to Node's timer max", () => {
  // Node setTimeout overflows past 2^31-1 ms (~24.85 days), firing at ~1ms.
  // Both an override and a bash input.timeout above the cap must clamp.
  assert.equal(
    resolveProxyCallTimeoutMs("task", undefined, { task: 2 ** 33 }),
    MAX_PROXY_TIMEOUT_MS,
  )
  assert.equal(
    resolveProxyCallTimeoutMs("bash", { timeout: 2 ** 33 }, undefined),
    MAX_PROXY_TIMEOUT_MS,
  )
})

test("buildProxyTimeoutError: generic message keeps the catch-block substrings", () => {
  // proxy-mcp's catch block classifies "timed out after" + "waiting for
  // opencode to resolve" as expected cleanup (notice, not warn). The Task
  // variant must keep both substrings too.
  const generic = buildProxyTimeoutError("bash", 600000)
  assert.match(generic.message, /timed out after 600000ms/)
  assert.match(generic.message, /waiting for opencode to resolve/)
  assert.doesNotMatch(generic.message, /wake-up/)
})

test("buildProxyTimeoutError: task message warns against scheduling a wake-up", () => {
  const task = buildProxyTimeoutError("task", 3600000)
  assert.match(task.message, /timed out after 3600000ms/)
  assert.match(task.message, /waiting for opencode to resolve/)
  assert.match(task.message, /may still be running/)
  assert.match(task.message, /wake-up/)
})

test("buildProxyTimeoutError: task guidance is case-insensitive on the tool name", () => {
  // Config / call sites use mixed casing ("Task"); the matcher lowercases.
  const task = buildProxyTimeoutError("Task", 60000)
  assert.match(task.message, /wake-up/)
  // And a non-task tool with unusual casing stays generic.
  const generic = buildProxyTimeoutError("BASH", 60000)
  assert.doesNotMatch(generic.message, /wake-up/)
})

test("tools/call timeout uses the per-tool override and surfaces the task-specific text", async () => {
  // Stand up a server with a tiny Task deadline and never resolve the call,
  // so the proxy-mcp timer fires and we see the real error envelope that
  // Claude would receive.
  const srv = await createProxyMcpServer(DEFAULT_PROXY_TOOLS, { task: 50 })
  try {
    // Intentionally do NOT attach a calls listener — let the deadline fire.
    const res = await post(srv.url, {
      jsonrpc: "2.0",
      id: "timeout-1",
      method: "tools/call",
      params: {
        name: "task",
        arguments: { description: "x", subagent_type: "gpt", prompt: "y" },
      },
    })
    assert.equal(res.json.id, "timeout-1")
    assert.equal(res.json.result.isError, true)
    const text = res.json.result.content[0].text
    assert.match(text, /timed out after 50ms/)
    assert.match(text, /wake-up/)
  } finally {
    await srv.close()
  }
})

test("tools/call bash timeout honours input.timeout over a shorter override", async () => {
  // Override says 40ms but the call asks for a 30s bash timeout — the
  // effective deadline must be 30s, so the call must NOT time out within a
  // short window. Resolve it ourselves to end the test promptly.
  const srv = await createProxyMcpServer(DEFAULT_PROXY_TOOLS, { bash: 40 })
  try {
    let resolved = false
    srv.calls.on("call", (call: ProxyToolCall) => {
      // Defer resolution past the 40ms override deadline to prove the
      // input.timeout (30s) is what governs.
      setTimeout(() => {
        resolved = true
        call.resolve({ kind: "text", text: "built" })
      }, 120)
    })
    const res = await post(srv.url, {
      jsonrpc: "2.0",
      id: "bash-1",
      method: "tools/call",
      params: { name: "bash", arguments: { command: "xcodebuild ...", timeout: 30000 } },
    })
    assert.equal(resolved, true, "call should resolve, not time out")
    assert.equal(res.json.result.isError, false)
    assert.equal(res.json.result.content[0].text, "built")
  } finally {
    await srv.close()
  }
})
