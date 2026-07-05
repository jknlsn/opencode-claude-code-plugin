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
  DEFAULT_PROXY_TOOLS,
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
