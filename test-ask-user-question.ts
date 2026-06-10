import assert from "node:assert/strict"
import { test } from "node:test"
import {
  denyMessageForTool,
  isAskUserQuestionTool,
} from "./src/claude-code-language-model.js"

test("isAskUserQuestionTool matches CLI casing variants", () => {
  assert.equal(isAskUserQuestionTool("AskUserQuestion"), true)
  assert.equal(isAskUserQuestionTool("ask_user_question"), true)
  assert.equal(isAskUserQuestionTool("askuserquestion"), true)
  assert.equal(isAskUserQuestionTool("Bash"), false)
  assert.equal(isAskUserQuestionTool(undefined), false)
})

// Regression guard for issue #8 ("Questions are skipped"): the deny message
// must instruct the model to stop and wait, with NO "proceed if
// non-interactive" escape hatch that the model used to take routinely.
test("AskUserQuestion deny message stops unconditionally", () => {
  const msg = denyMessageForTool("AskUserQuestion")
  assert.match(msg, /stop now/i)
  assert.match(msg, /wait for the operator/i)
  assert.match(msg, /do not guess/i)
  // Must explicitly defuse the "the user cancelled, so I'll proceed"
  // rationalization the model otherwise reaches for after the deny.
  assert.match(msg, /not a cancellation/i)
  assert.match(msg, /cancelled, skipped, or declined/i)
  // None of the old "proceed if non-interactive" escape-hatch markers.
  assert.doesNotMatch(msg, /non-interactive/i)
  assert.doesNotMatch(msg, /reasonable/i)
  assert.doesNotMatch(msg, /do not stall/i)
  // Same message regardless of any configured fallback.
  assert.equal(denyMessageForTool("ask_user_question", "custom fallback"), msg)
})

test("non-question tools use configured or default deny message", () => {
  assert.equal(
    denyMessageForTool("Bash", "blocked by policy"),
    "blocked by policy",
  )
  assert.equal(
    denyMessageForTool("Bash"),
    "Denied by opencode-claude-code policy for tool Bash",
  )
})
