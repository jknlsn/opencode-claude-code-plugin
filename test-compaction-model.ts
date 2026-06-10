import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  buildAppendedSystemPrompt,
  DEFAULT_COMPACTION_MODEL,
  resolveCompactionModel,
} from "./src/claude-code-language-model.js"

function withCompactionEnv<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env.CLAUDE_CODE_COMPACTION_MODEL
  try {
    if (value === undefined) {
      delete process.env.CLAUDE_CODE_COMPACTION_MODEL
    } else {
      process.env.CLAUDE_CODE_COMPACTION_MODEL = value
    }
    return fn()
  } finally {
    if (previous === undefined) {
      delete process.env.CLAUDE_CODE_COMPACTION_MODEL
    } else {
      process.env.CLAUDE_CODE_COMPACTION_MODEL = previous
    }
  }
}

test("resolveCompactionModel falls back to default when nothing is set", () => {
  withCompactionEnv(undefined, () => {
    assert.equal(resolveCompactionModel(), DEFAULT_COMPACTION_MODEL)
    assert.equal(resolveCompactionModel(undefined), DEFAULT_COMPACTION_MODEL)
    assert.equal(resolveCompactionModel(""), DEFAULT_COMPACTION_MODEL)
    assert.equal(resolveCompactionModel("   "), DEFAULT_COMPACTION_MODEL)
  })
})

test("resolveCompactionModel uses configured value when env is unset", () => {
  withCompactionEnv(undefined, () => {
    assert.equal(resolveCompactionModel("claude-sonnet-4-6"), "claude-sonnet-4-6")
    assert.equal(resolveCompactionModel("  claude-opus-4-7  "), "claude-opus-4-7")
  })
})

test("CLAUDE_CODE_COMPACTION_MODEL env wins over configured value", () => {
  withCompactionEnv("claude-haiku-4-5", () => {
    assert.equal(resolveCompactionModel("claude-opus-4-7"), "claude-haiku-4-5")
  })
  withCompactionEnv("  claude-sonnet-4-6  ", () => {
    assert.equal(resolveCompactionModel("claude-opus-4-7"), "claude-sonnet-4-6")
  })
})

test("empty env var falls through to configured/default", () => {
  withCompactionEnv("", () => {
    assert.equal(resolveCompactionModel(), DEFAULT_COMPACTION_MODEL)
    assert.equal(resolveCompactionModel("claude-opus-4-7"), "claude-opus-4-7")
  })
  withCompactionEnv("   ", () => {
    assert.equal(resolveCompactionModel("claude-opus-4-7"), "claude-opus-4-7")
  })
})

test("interactive prompt mitigation can omit forwarded opencode system prompt", () => {
  const tmp = mkdtempSync(join(tmpdir(), "opencode-cc-test-"))
  const previousConfigHome = process.env.XDG_CONFIG_HOME
  let promptFile: string | undefined

  try {
    process.env.XDG_CONFIG_HOME = join(tmp, "config")
    promptFile = buildAppendedSystemPrompt(tmp, true)
    assert.ok(promptFile)
    const content = readFileSync(promptFile, "utf8")

    assert.match(content, /Runtime environment: Claude Code CLI/)
    assert.match(content, /Continuing through multi-step tasks/)
    assert.doesNotMatch(content, /FORWARDED_OPENCODE_SYSTEM_PROMPT/)
  } finally {
    if (promptFile) unlinkSync(promptFile)
    if (previousConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = previousConfigHome
    }
    rmSync(tmp, { recursive: true, force: true })
  }
})

test("headless prompt path still preserves forwarded opencode system prompt", () => {
  const tmp = mkdtempSync(join(tmpdir(), "opencode-cc-test-"))
  const previousConfigHome = process.env.XDG_CONFIG_HOME
  let promptFile: string | undefined

  try {
    process.env.XDG_CONFIG_HOME = join(tmp, "config")
    promptFile = buildAppendedSystemPrompt(tmp, true, [
      "FORWARDED_OPENCODE_SYSTEM_PROMPT",
    ])
    assert.ok(promptFile)
    const content = readFileSync(promptFile, "utf8")

    assert.match(content, /FORWARDED_OPENCODE_SYSTEM_PROMPT/)
  } finally {
    if (promptFile) unlinkSync(promptFile)
    if (previousConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = previousConfigHome
    }
    rmSync(tmp, { recursive: true, force: true })
  }
})
