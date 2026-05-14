/**
 * Unit tests for getClaudeUserMessage in src/message-builder.ts.
 *
 * Covers the v0.4.8 fix: tool-role messages (AI SDK V3 shape) must produce
 * tool_result content blocks instead of falling through to the "(empty)"
 * sentinel — otherwise opencode's outer agent loop hangs after every proxy
 * tool call, forcing the user to press "continue".
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { getClaudeUserMessage } from "./src/message-builder.js"

const p = (msgs: any[]) => msgs as any

function parsed(prompt: any) {
  return JSON.parse(getClaudeUserMessage(prompt))
}

test("tool-role tool-result produces tool_result block, not sentinel", () => {
  const out = parsed(
    p([
      { role: "user", content: "run bash" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            output: { type: "text", value: "hello from bash" },
          },
        ],
      },
    ]),
  )

  const blocks = out.message.content
  assert.equal(Array.isArray(blocks), true)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, "tool_result")
  assert.equal(blocks[0].tool_use_id, "call_1")
  // Must NOT be the "(empty)" sentinel.
  assert.notEqual(blocks[0].type, "text")
})

test("multiple tool-results in single tool-role message all flow through", () => {
  const out = parsed(
    p([
      { role: "user", content: "do both" },
      { role: "assistant", content: [{ type: "text", text: "running" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_a",
            output: { type: "text", value: "a result" },
          },
          {
            type: "tool-result",
            toolCallId: "call_b",
            output: { type: "text", value: "b result" },
          },
        ],
      },
    ]),
  )

  const blocks = out.message.content
  assert.equal(blocks.length, 2)
  assert.deepEqual(
    blocks.map((b: any) => [b.type, b.tool_use_id]),
    [
      ["tool_result", "call_a"],
      ["tool_result", "call_b"],
    ],
  )
})

test("tool-role without tool-result parts still falls through to sentinel", () => {
  const out = parsed(
    p([
      { role: "user", content: "x" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      {
        role: "tool",
        content: [{ type: "something-else" }],
      },
    ]),
  )

  // No tool-result extracted → falls through to "(empty)" sentinel path
  // (correct behavior, matches hasNewUserContent's symmetry).
  const blocks = out.message.content
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].type, "text")
  assert.equal(blocks[0].text, "(empty)")
})

test("mixed user-text + tool-role both flow into the same content array", () => {
  const out = parsed(
    p([
      { role: "user", content: "first turn" },
      { role: "assistant", content: [{ type: "text", text: "running tool" }] },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            output: { type: "text", value: "tool output" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "text", text: "follow-up question" }],
      },
    ]),
  )

  const blocks = out.message.content
  // Should have both the tool_result and the follow-up text, no sentinel.
  const types = blocks.map((b: any) => b.type)
  assert.ok(types.includes("tool_result"), `expected tool_result in ${types}`)
  assert.ok(types.includes("text"), `expected text in ${types}`)
  // No "(empty)" sentinel injected.
  const textBlock = blocks.find((b: any) => b.type === "text")
  assert.notEqual(textBlock.text, "(empty)")
})
