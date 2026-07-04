import assert from "node:assert/strict"
import { test } from "node:test"
import { SUBAGENT_DISPATCH_HINT } from "./src/claude-code-language-model.js"
import {
  DEFAULT_PROXY_TOOLS,
  overlayTaskProxyDescription,
  TASK_PROXY_NOTE,
} from "./src/proxy-mcp.js"

// Regression guard for the 2026-07-04 "subagents only write todos" report:
// opencode's @-mention hint says "call the task tool with subagent: X", and
// models resolved that to Claude Code's native TaskCreate (a todo tool),
// created a todo, and narrated a dispatch that never happened. The system
// hint must name the exact proxy tool, the ToolSearch recovery path for
// deferred tools, and explicitly defuse the TaskCreate near-miss.
test("subagent dispatch hint names the tool and defuses TaskCreate", () => {
  assert.match(SUBAGENT_DISPATCH_HINT, /mcp__opencode_proxy__task/)
  assert.match(SUBAGENT_DISPATCH_HINT, /ToolSearch/)
  assert.match(SUBAGENT_DISPATCH_HINT, /select:mcp__opencode_proxy__task/)
  assert.match(SUBAGENT_DISPATCH_HINT, /TaskCreate/)
  assert.match(SUBAGENT_DISPATCH_HINT, /todo list/i)
  assert.match(SUBAGENT_DISPATCH_HINT, /subagent_type/)
  // The "don't grep configs to verify agents" guard (opus burned ~8 tool
  // calls doing exactly that before dispatching).
  assert.match(SUBAGENT_DISPATCH_HINT, /config files/i)
})

test("static task proxy def carries the disambiguation note", () => {
  const task = DEFAULT_PROXY_TOOLS.find((t) => t.name === "task")
  assert.ok(task, "task def missing from DEFAULT_PROXY_TOOLS")
  assert.ok(task!.description.includes(TASK_PROXY_NOTE))
  assert.match(task!.description, /TaskCreate/)
})

test("overlayTaskProxyDescription replaces task description with live + note", () => {
  const live = "Launch a subagent.\n\nAvailable agent types and the tools they have access to:\n- glm: GLM 5.2"
  const out = overlayTaskProxyDescription(DEFAULT_PROXY_TOOLS, live)
  const task = out.find((t) => t.name === "task")!
  assert.ok(task.description.startsWith(live))
  assert.ok(task.description.endsWith(TASK_PROXY_NOTE))
  // Other defs untouched (same object references).
  const bashIn = DEFAULT_PROXY_TOOLS.find((t) => t.name === "bash")!
  const bashOut = out.find((t) => t.name === "bash")!
  assert.equal(bashOut, bashIn)
  // Source array not mutated.
  const original = DEFAULT_PROXY_TOOLS.find((t) => t.name === "task")!
  assert.ok(!original.description.includes("Available agent types"))
})

test("overlayTaskProxyDescription is a no-op without a live description", () => {
  assert.deepEqual(
    overlayTaskProxyDescription(DEFAULT_PROXY_TOOLS, undefined),
    DEFAULT_PROXY_TOOLS,
  )
  assert.deepEqual(
    overlayTaskProxyDescription(DEFAULT_PROXY_TOOLS, "   "),
    DEFAULT_PROXY_TOOLS,
  )
})
