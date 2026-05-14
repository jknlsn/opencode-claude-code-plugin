/**
 * Unit tests for smart auto-continuation policy in
 * src/claude-code-language-model.ts.
 */
import { test } from "node:test"
import assert from "node:assert/strict"

import { shouldAutoContinueIncompleteTurn } from "./src/claude-code-language-model.js"

function state(overrides: Record<string, unknown> = {}) {
  return {
    enabled: "smart" as const,
    attempts: 0,
    startedAt: 1_000,
    noProgressCount: 0,
    ...overrides,
  } as any
}

function snap(overrides: Record<string, unknown> = {}) {
  const base: Record<string, unknown> = {
    text: "",
    lastVisibleText: "",
    hadReasoning: false,
    hadToolActivity: false,
    hadProxyActivity: false,
    now: 1_500,
    ...overrides,
  }
  // Default lastVisibleText to mirror text unless explicitly overridden, so
  // legacy single-block test cases keep working.
  if (
    overrides.text !== undefined &&
    overrides.lastVisibleText === undefined
  ) {
    base.lastVisibleText = overrides.text
  }
  return base as any
}

test("smart auto-continue is disabled by false", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state({ enabled: false }),
    snap({ hadReasoning: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "disabled" })
})

test("continues reasoning-only result with no visible answer", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ hadReasoning: true }),
  )
  assert.equal(result.continue, true)
  assert.equal(result.reason, "activity-without-visible-answer")
})

test("continues tool activity without visible answer", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ hadToolActivity: true }),
  )
  assert.equal(result.continue, true)
})

test("continues non-final visible progress", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ text: "I found the relevant files and am checking the tests.", hadToolActivity: true }),
  )
  assert.deepEqual(result, { continue: true, reason: "non-final-progress" })
})

test("stops for final-looking visible answer", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ text: "Done. Implemented the fix and tests passed successfully.", hadToolActivity: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "final-answer" })
})

test("stops for question", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ text: "Which option do you want me to use?", hadReasoning: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("stops for blocker", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ text: "I cannot proceed because the required token is missing.", hadToolActivity: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "blocker" })
})

test("stops for errors", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({ isError: true, hadToolActivity: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "error" })
})

test("stops at max attempts", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state({ attempts: 8 }),
    snap({ hadReasoning: true }),
  )
  assert.deepEqual(result, { continue: false, reason: "max-attempts" })
})

test("stops when elapsed budget is exhausted", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state({ startedAt: 0 }),
    snap({ hadReasoning: true, now: 10 * 60 * 1000 + 1 }),
  )
  assert.deepEqual(result, { continue: false, reason: "max-elapsed" })
})

test("stops on repeated no-progress continuation", () => {
  const snapshot = snap({ hadReasoning: true })
  const first = shouldAutoContinueIncompleteTurn(state(), snapshot)
  assert.equal(first.continue, true)

  const second = shouldAutoContinueIncompleteTurn(
    state({
      lastSignature: JSON.stringify({
        text: "",
        reasoning: true,
        tools: false,
        proxy: false,
      }),
      noProgressCount: 1,
    }),
    snapshot,
  )
  assert.deepEqual(second, { continue: false, reason: "no-progress" })
})

test("stops when there was no activity", () => {
  const result = shouldAutoContinueIncompleteTurn(state(), snap())
  assert.deepEqual(result, { continue: false, reason: "no-activity" })
})

test("ignores final-answer keywords in earlier text blocks", () => {
  // Earlier mid-task narration contains keywords like 'implemented' and
  // 'updated' — but the LAST text block is a mid-task pause. Should still
  // continue.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text:
        "I implemented the helper. Updated the search index. " +
        "Now checking the next set of files.",
      lastVisibleText: "Now checking the next set of files.",
      hadToolActivity: true,
    }),
  )
  assert.equal(result.continue, true)
  assert.equal(result.reason, "non-final-progress")
})

test("stops when the last text block looks like a final answer", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text:
        "Let me check the files. " +
        "Found three matches. " +
        "Done. Implemented the fix and tests passed successfully.",
      lastVisibleText:
        "Done. Implemented the fix and tests passed successfully.",
      hadToolActivity: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "final-answer" })
})

test("question in any earlier text block still stops continuation", () => {
  // Even if the last block looks mid-task, a question raised earlier in the
  // turn should still block auto-continue — answering a question is the
  // user's job.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text:
        "Which option do you want me to use? Continuing with the first one for now.",
      lastVisibleText: "Continuing with the first one for now.",
      hadToolActivity: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

// ─── v0.4.10 regression tests for tweaks 2, 3, 4, 5 ────────────────────────

test("v0.4.10 tweak 2: 'let me know if you'd like' stops as question", () => {
  // Indirect offer of next steps without literal '?'. C03 in the sim corpus.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text:
        "Let me know if you'd like me to proceed with the cleanup phase or stop here.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.10 tweak 3: 'needs your approval' stops as blocker", () => {
  // 'needs your' is intent-equivalent to 'requires your' but slipped past
  // the regex pre-0.4.10. D03 in the sim corpus.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text:
        "Needs your approval before I push the tag — auto-push is not enabled.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "blocker" })
})

test("v0.4.10 tweak 4: short completion (36 chars) stops as final-answer", () => {
  // Pre-0.4.10 floor of 40 chars let "Task is now completely done. Pushed."
  // through as non-final-progress. Floor lowered to 30. I01 in the sim corpus.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "Task is now completely done. Pushed.",
      hadToolActivity: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "final-answer" })
})

test("v0.4.10 tweak 5a: '?' anywhere in last block stops as question", () => {
  // Real fire shape from 2026-05-14T03:31 — long answer that asks a
  // question early then lists options and ends in a period.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text:
        "Here's the plan. Want me to proceed with that? Concretely: 1. Do X. 2. Do Y. 3. Do Z. Say 'go' or push back on any step.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.10 tweak 5b: 'say go or push back' (no '?') stops as question", () => {
  // Pure soft-proceed phrasing with no '?' anywhere. Tests that the
  // phrase-based half of tweak 5 fires independently of the '?' check.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text:
        "Pick the option you want. Say 'go' to ship as planned, or push back on any specific step.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.10 tweak 5c: 'if you want to' stops as question", () => {
  // Reconstruction of 02:48:11-style fire — long analysis ending in a
  // conditional action offer with no '?'.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text:
        "Three options are on the table. The recommendation is to leave DEBUG off. Consider option C if you want to re-enable DEBUG without UI noise.",
      hadReasoning: true, hadToolActivity: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.10 tweak 5d: A-class continues unaffected (no '?' or soft-proceed phrase)", () => {
  // Sanity check: mid-task narration without question signals should still
  // continue. Catches regressions where '?' or phrase regex accidentally
  // expands.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "Now I'll read the file. Then I'll diff against previous. Then summarize.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: true, reason: "non-final-progress" })
})

// ─── v0.4.11 regression tests ──────────────────────────────────────────────

test("v0.4.11 'ready when you are' stops as question", () => {
  // Real fire from 2026-05-14T04:00:41 — short answer ending in this
  // canonical 'your move' phrase fired 4-δ inappropriately on v0.4.10.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "The standing-by stub lives in training, not just the CLI's empty-turn behavior. Ready when you are.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.11 'standing by' stops as question (the meta-irony stub)", () => {
  // Commit 49345e3 originally fought 'No input received. Standing by.' at
  // the message-builder layer (suppressing the CLI stub on empty turns).
  // This test guards against the model organically producing the same
  // idiom at the response layer.
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "All done on my side; the rest is on you. Standing by.",
      hadReasoning: true, hadToolActivity: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})

test("v0.4.11 'let me know when' stops as question", () => {
  const result = shouldAutoContinueIncompleteTurn(
    state(),
    snap({
      text: "I've staged everything for the release. Let me know when you've reviewed.",
      hadReasoning: true,
    }),
  )
  assert.deepEqual(result, { continue: false, reason: "question" })
})
