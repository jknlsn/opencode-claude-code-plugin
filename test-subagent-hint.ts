import assert from "node:assert/strict"
import { test } from "node:test"
import { SUBAGENT_DISPATCH_HINT, QUESTION_PROXY_HINT } from "./src/claude-code-language-model.js"
import {
  DEFAULT_PROXY_TOOLS,
  overlayTaskProxyDescription,
  overlayQuestionProxyDescription,
  filterQuestionProxyByOpencodeSupport,
  disallowedToolFlags,
  TASK_PROXY_NOTE,
  QUESTION_PROXY_NOTE,
  type ProxyToolDef,
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

// --- question proxy: static def, live overlay, version gate ----------

test("static question proxy def is present and carries the disambiguation note", () => {
  const question = DEFAULT_PROXY_TOOLS.find((t) => t.name === "question")
  assert.ok(question, "question def missing from DEFAULT_PROXY_TOOLS")
  assert.ok(question!.description.includes(QUESTION_PROXY_NOTE))
  // Schema must mirror opencode's Prompt struct: questions[].{question,header,options,multiple?}.
  assert.equal(question!.inputSchema.type, "object")
  const props = question!.inputSchema.properties as Record<string, any>
  assert.ok(props.questions, "questions property missing")
  assert.deepEqual(question!.inputSchema.required, ["questions"])
  const item = props.questions.items.properties
  assert.deepEqual(
    Object.keys(item).sort(),
    ["header", "multiple", "options", "question"],
  )
  assert.deepEqual(item.options.items.required, ["label", "description"])
})

test("overlayQuestionProxyDescription prepends live description, keeps the note", () => {
  const live =
    "Use this tool when you need to ask the user questions during execution."
  const out = overlayQuestionProxyDescription(DEFAULT_PROXY_TOOLS, live)
  const question = out.find((t) => t.name === "question")!
  assert.ok(question.description.startsWith(live))
  assert.ok(question.description.endsWith(QUESTION_PROXY_NOTE))
  // Other defs untouched (same object references).
  const bashIn = DEFAULT_PROXY_TOOLS.find((t) => t.name === "bash")!
  const bashOut = out.find((t) => t.name === "bash")!
  assert.equal(bashOut, bashIn)
  // task def untouched too — overlay is question-scoped.
  const taskOut = out.find((t) => t.name === "task")!
  assert.ok(!taskOut.description.includes(live))
  // Source array not mutated.
  const original = DEFAULT_PROXY_TOOLS.find((t) => t.name === "question")!
  assert.ok(!original.description.includes("Use this tool"))
})

test("overlayQuestionProxyDescription is a no-op without a live description", () => {
  assert.deepEqual(
    overlayQuestionProxyDescription(DEFAULT_PROXY_TOOLS, undefined),
    DEFAULT_PROXY_TOOLS,
  )
  assert.deepEqual(
    overlayQuestionProxyDescription(DEFAULT_PROXY_TOOLS, "  "),
    DEFAULT_PROXY_TOOLS,
  )
  // Only-blank live must not blow away the static note-backed description.
  const out = overlayQuestionProxyDescription(DEFAULT_PROXY_TOOLS, "  ")
  const question = out.find((t) => t.name === "question")!
  assert.ok(question.description.includes(QUESTION_PROXY_NOTE))
})

test("filterQuestionProxyByOpencodeSupport drops the def when unsupported", () => {
  // Older opencode builds lack the `question` registry entry; keeping the
  // def would render a forwarded call as `⚙ invalid`.
  const out = filterQuestionProxyByOpencodeSupport(DEFAULT_PROXY_TOOLS, false)
  assert.ok(!out.some((t) => t.name === "question"))
  // Other defs preserved (bash/task/etc. untouched).
  assert.ok(out.some((t) => t.name === "bash"))
  assert.ok(out.some((t) => t.name === "task"))
  assert.equal(out.length, DEFAULT_PROXY_TOOLS.length - 1)
})

test("filterQuestionProxyByOpencodeSupport keeps the def when supported", () => {
  assert.deepEqual(
    filterQuestionProxyByOpencodeSupport(DEFAULT_PROXY_TOOLS, true),
    DEFAULT_PROXY_TOOLS,
  )
  // Works on a filtered subset too.
  const subset: ProxyToolDef[] = [
    DEFAULT_PROXY_TOOLS.find((t) => t.name === "question")!,
    DEFAULT_PROXY_TOOLS.find((t) => t.name === "bash")!,
  ]
  assert.deepEqual(
    filterQuestionProxyByOpencodeSupport(subset, true),
    subset,
  )
})

test("filterQuestionProxyByOpencodeSupport is a no-op when no question def is present", () => {
  const noQuestion = DEFAULT_PROXY_TOOLS.filter((t) => t.name !== "question")
  assert.deepEqual(
    filterQuestionProxyByOpencodeSupport(noQuestion, false),
    noQuestion,
  )
})

// Critical regression guard: the spawn site must compute --disallowedTools
// from the POST-FILTER proxy list, not the pre-filter one. When the
// version gate drops `question` (older opencode without the registry
// entry), AskUserQuestion must NOT be disabled — otherwise the native
// tool is gone AND the proxy replacement is absent, leaving the model
// unable to ask questions at all. This test pins the invariant by
// simulating the exact filter-then-flag sequence the spawn site runs.
test("version gate + disallowedToolFlags: dropping question also drops AskUserQuestion disable", () => {
  // A config that proxies question alongside the standard tools.
  const resolved = [
    DEFAULT_PROXY_TOOLS.find((t) => t.name === "bash")!,
    DEFAULT_PROXY_TOOLS.find((t) => t.name === "question")!,
  ]

  // Supported opencode: question stays → AskUserQuestion is disabled.
  const supported = filterQuestionProxyByOpencodeSupport(resolved, true)
  assert.ok(supported.some((t) => t.name === "question"))
  const supportedFlags = disallowedToolFlags(supported)
  assert.ok(supportedFlags.includes("AskUserQuestion"))

  // Unsupported opencode: question is dropped → AskUserQuestion must NOT
  // be in the disallowed list, so the deny/markdown fallback path stays
  // reachable. The pre-filter array would still have it — the bug.
  const unsupported = filterQuestionProxyByOpencodeSupport(resolved, false)
  assert.ok(!unsupported.some((t) => t.name === "question"))
  const unsupportedFlags = disallowedToolFlags(unsupported)
  assert.ok(!unsupportedFlags.includes("AskUserQuestion"))
  // Sanity: bash is still disabled in both cases.
  assert.ok(unsupportedFlags.includes("Bash"))
})

test("no empty proxy server: combined list is empty when all defs are filtered out", () => {
  // proxyTools: ["Question"] on unsupported opencode → the version gate
  // drops the only def, leaving an empty array. The spawn site must treat
  // this as "no proxy" (null), not start a server with zero tools.
  const onlyQuestion = [DEFAULT_PROXY_TOOLS.find((t) => t.name === "question")!]
  const filtered = filterQuestionProxyByOpencodeSupport(onlyQuestion, false)
  assert.equal(filtered.length, 0)
  // The caller checks combinedList.length > 0 — pin that an empty filtered
  // array is indeed length 0, not truthy-but-empty.
  assert.equal(filtered.length > 0, false)
})

// Regression guard for the 2026-07-05 haiku test: the model's reasoning
// correctly identified mcp__opencode_proxy__question but then emitted a
// tool call for bare `question` (stripping the MCP prefix), which
// opencode rejected as "Model tried to call unavailable tool 'question'".
// The hint must name the exact full tool name and explicitly forbid the
// bare short name.
test("question proxy hint names the exact MCP tool and defuses bare 'question'", () => {
  assert.match(QUESTION_PROXY_HINT, /mcp__opencode_proxy__question/)
  assert.match(QUESTION_PROXY_HINT, /select:mcp__opencode_proxy__question/)
  // Must explicitly warn against calling bare `question`.
  assert.match(QUESTION_PROXY_HINT, /Do NOT call bare `question`/)
  // Must mention that AskUserQuestion is disabled.
  assert.match(QUESTION_PROXY_HINT, /AskUserQuestion/)
  assert.match(QUESTION_PROXY_HINT, /disabled/i)
})
