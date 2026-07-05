import assert from "node:assert/strict"
import { test } from "node:test"
import {
  buildCliArgs,
  claudeSpawnEnv,
  isClaudeThinkingDisabled,
} from "./src/session-manager.js"
import {
  cliSupportsThinking,
  cliSupportsThinkingDisplay,
} from "./src/cli-version.js"
import {
  disallowedToolFlags,
  type ProxyToolDef,
} from "./src/proxy-mcp.js"

function withClaudeThinkingEnv<T>(
  env: {
    disableThinking?: string
    disableAdaptiveThinking?: string
    showSummaries?: string
  },
  fn: () => T,
): T {
  const previous = {
    disableThinking: process.env.CLAUDE_CODE_DISABLE_THINKING,
    disableAdaptiveThinking: process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING,
    showSummaries: process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES,
  }

  try {
    if (env.disableThinking === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_THINKING
    } else {
      process.env.CLAUDE_CODE_DISABLE_THINKING = env.disableThinking
    }
    if (env.disableAdaptiveThinking === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING
    } else {
      process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = env.disableAdaptiveThinking
    }
    if (env.showSummaries === undefined) {
      delete process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES
    } else {
      process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES = env.showSummaries
    }
    return fn()
  } finally {
    if (previous.disableThinking === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_THINKING
    } else {
      process.env.CLAUDE_CODE_DISABLE_THINKING = previous.disableThinking
    }
    if (previous.disableAdaptiveThinking === undefined) {
      delete process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING
    } else {
      process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = previous.disableAdaptiveThinking
    }
    if (previous.showSummaries === undefined) {
      delete process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES
    } else {
      process.env.CLAUDE_CODE_SHOW_THINKING_SUMMARIES = previous.showSummaries
    }
  }
}

test("thinking-display is gated on Claude Code CLI 2.1.142+", () => {
  assert.equal(cliSupportsThinkingDisplay(null), false)
  assert.equal(
    cliSupportsThinkingDisplay({ major: 2, minor: 1, patch: 141, raw: "2.1.141" }),
    false,
  )
  assert.equal(
    cliSupportsThinkingDisplay({ major: 2, minor: 1, patch: 142, raw: "2.1.142" }),
    true,
  )
  assert.equal(
    cliSupportsThinkingDisplay({ major: 2, minor: 2, patch: 0, raw: "2.2.0" }),
    true,
  )
})

test("buildCliArgs skips unsupported thinking-display flag", () => {
  const args = buildCliArgs({
    sessionKey: "test",
    skipPermissions: true,
    model: "claude-opus-4-7",
    thinking: "enabled",
    thinkingDisplay: "summarized",
    cliVersion: { major: 2, minor: 1, patch: 141, raw: "2.1.141" },
  })

  assert.equal(args.includes("--thinking"), true)
  assert.equal(args.includes("enabled"), true)
  assert.equal(args.includes("--thinking-display"), false)
  assert.equal(args.includes("summarized"), false)
})

test("cliSupportsThinking floors at 2.0.0", () => {
  assert.equal(cliSupportsThinking(null), false)
  assert.equal(
    cliSupportsThinking({ major: 1, minor: 99, patch: 99, raw: "1.99.99" }),
    false,
  )
  assert.equal(
    cliSupportsThinking({ major: 2, minor: 0, patch: 0, raw: "2.0.0" }),
    true,
  )
  assert.equal(
    cliSupportsThinking({ major: 2, minor: 1, patch: 142, raw: "2.1.142" }),
    true,
  )
})

test("buildCliArgs skips --thinking when cliVersion is unknown", () => {
  const args = buildCliArgs({
    sessionKey: "test",
    skipPermissions: true,
    model: "claude-opus-4-7",
    thinking: "enabled",
    cliVersion: null,
  })

  assert.equal(args.includes("--thinking"), false)
  assert.equal(args.includes("enabled"), false)
})

test("buildCliArgs skips --thinking on pre-2.x CLI", () => {
  const args = buildCliArgs({
    sessionKey: "test",
    skipPermissions: true,
    model: "claude-opus-4-7",
    thinking: "enabled",
    cliVersion: { major: 1, minor: 5, patch: 0, raw: "1.5.0" },
  })

  assert.equal(args.includes("--thinking"), false)
})

test("buildCliArgs emits thinking-display for supported CLI", () => {
  const args = buildCliArgs({
    sessionKey: "test",
    skipPermissions: true,
    model: "claude-opus-4-7",
    thinking: "enabled",
    thinkingDisplay: "summarized",
    cliVersion: { major: 2, minor: 1, patch: 142, raw: "2.1.142" },
  })

  assert.equal(args.includes("--thinking"), true)
  assert.equal(args.includes("enabled"), true)
  assert.equal(args.includes("--thinking-display"), true)
  assert.equal(args.includes("summarized"), true)
})

test("Claude thinking env defaults preserve explicit user choices", () => {
  withClaudeThinkingEnv({}, () => {
    assert.equal(isClaudeThinkingDisabled(), false)
    assert.equal(claudeSpawnEnv().CLAUDE_CODE_SHOW_THINKING_SUMMARIES, "1")
  })

  withClaudeThinkingEnv({ showSummaries: "0" }, () => {
    assert.equal(isClaudeThinkingDisabled(), false)
    assert.equal(claudeSpawnEnv().CLAUDE_CODE_SHOW_THINKING_SUMMARIES, "0")
  })

  withClaudeThinkingEnv({ disableThinking: "1" }, () => {
    assert.equal(isClaudeThinkingDisabled(), true)
    assert.equal(claudeSpawnEnv().CLAUDE_CODE_SHOW_THINKING_SUMMARIES, undefined)
  })

  withClaudeThinkingEnv({ disableAdaptiveThinking: "false" }, () => {
    assert.equal(isClaudeThinkingDisabled(), false)
    assert.equal(claudeSpawnEnv().CLAUDE_CODE_SHOW_THINKING_SUMMARIES, "1")
  })
})

// `disallowedToolFlags` translates resolved proxy tool names into the
// Claude built-ins that must be passed to `--disallowedTools` so the
// model can only reach the proxied MCP version. The `question` row is
// the new one — it must disable Claude's built-in `AskUserQuestion` so
// the structured-questions path flows through opencode's `question` tool.
function proxyDef(name: string): ProxyToolDef {
  return {
    name,
    description: "",
    inputSchema: { type: "object", properties: {} },
  }
}

test("disallowedToolFlags maps each proxy tool to its Claude built-ins", () => {
  assert.deepEqual(
    disallowedToolFlags([proxyDef("bash")]),
    ["Bash"],
  )
  assert.deepEqual(
    disallowedToolFlags([proxyDef("write")]),
    ["Write"],
  )
  // Edit also disables MultiEdit (opencode has no batched-edit equivalent).
  assert.deepEqual(
    disallowedToolFlags([proxyDef("edit")]),
    ["Edit", "MultiEdit"],
  )
  assert.deepEqual(
    disallowedToolFlags([proxyDef("webfetch")]),
    ["WebFetch"],
  )
  assert.deepEqual(
    disallowedToolFlags([proxyDef("task")]),
    ["Agent"],
  )
})

test("disallowedToolFlags disables AskUserQuestion for the question proxy", () => {
  assert.deepEqual(
    disallowedToolFlags([proxyDef("question")]),
    ["AskUserQuestion"],
  )
})

test("disallowedToolFlags is case-insensitive on the proxy tool name", () => {
  // `resolvedProxyTools` lowercases when matching DEFAULT_PROXY_TOOLS, but
  // disallowedToolFlags must tolerate either casing since callers pass the
  // def name as-authored.
  assert.deepEqual(
    disallowedToolFlags([proxyDef("Question")]),
    ["AskUserQuestion"],
  )
  assert.deepEqual(
    disallowedToolFlags([proxyDef("TASK")]),
    ["Agent"],
  )
})

test("disallowedToolFlags dedupes and preserves order across combined defs", () => {
  // A real config typically has several proxies at once.
  const out = disallowedToolFlags([
    proxyDef("bash"),
    proxyDef("edit"),
    proxyDef("write"),
    proxyDef("task"),
    proxyDef("question"),
  ])
  assert.deepEqual(out, [
    "Bash",
    "Edit",
    "MultiEdit",
    "Write",
    "Agent",
    "AskUserQuestion",
  ])
})

test("disallowedToolFlags ignores proxy tools with no Claude equivalent", () => {
  // MCP-bridged proxy tools (server-derived names) have no entry in the
  // nameMap and must be skipped, not crash.
  assert.deepEqual(
    disallowedToolFlags([proxyDef("slack_post_message")]),
    [],
  )
  assert.deepEqual(
    disallowedToolFlags([proxyDef("bash"), proxyDef("slack_post_message")]),
    ["Bash"],
  )
})
