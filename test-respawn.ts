/**
 * Unit tests for the reused-process respawn path in src/session-manager.ts.
 *
 * These cover the pure helpers (`appendSessionIdIfNeeded`) and the
 * undefined-when-no-active-process branch of `respawnActiveProcess`. The
 * full respawn spawns a real child and is exercised live by the doStream
 * start-watchdog, not here.
 *
 * Usage:
 *   npx tsx --test test-respawn.ts
 */
import assert from "node:assert/strict"
import { test } from "node:test"

import {
  appendSessionIdIfNeeded,
  respawnActiveProcess,
  setClaudeSessionId,
  deleteClaudeSessionId,
} from "./src/session-manager.js"

test("appendSessionIdIfNeeded: no-op when no claude session id is known", () => {
  const sk = `sk-noid-${Date.now()}`
  deleteClaudeSessionId(sk)
  const args = ["--print", "--model", "claude-fable-5"]
  assert.deepEqual(appendSessionIdIfNeeded(sk, args), args)
})

test("appendSessionIdIfNeeded: appends --session-id when a conversation id is known", () => {
  const sk = `sk-withid-${Date.now()}`
  setClaudeSessionId(sk, "claude-conv-123")
  try {
    const args = ["--print", "--model", "claude-fable-5"]
    assert.deepEqual(appendSessionIdIfNeeded(sk, args), [
      "--print",
      "--model",
      "claude-fable-5",
      "--session-id",
      "claude-conv-123",
    ])
  } finally {
    deleteClaudeSessionId(sk)
  }
})

test("appendSessionIdIfNeeded: does not duplicate --session-id when already present", () => {
  const sk = `sk-hasarg-${Date.now()}`
  setClaudeSessionId(sk, "claude-conv-456")
  try {
    const args = ["--print", "--session-id", "claude-conv-already"]
    assert.deepEqual(appendSessionIdIfNeeded(sk, args), args)
  } finally {
    deleteClaudeSessionId(sk)
  }
})

test("appendSessionIdIfNeeded: does not mutate the input array", () => {
  const sk = `sk-immutable-${Date.now()}`
  setClaudeSessionId(sk, "claude-conv-789")
  try {
    const args = ["--print"]
    const snapshot = [...args]
    appendSessionIdIfNeeded(sk, args)
    assert.deepEqual(args, snapshot)
  } finally {
    deleteClaudeSessionId(sk)
  }
})

test("respawnActiveProcess: returns undefined when no active process exists for the key", () => {
  const sk = `sk-empty-${Date.now()}`
  // No setActiveProcess(spawnClaudeProcess(...)) was done for this key, so
  // there is nothing to respawn — the watchdog treats this as "give up".
  assert.equal(
    respawnActiveProcess(sk, "/usr/bin/env", ["--print"], process.cwd()),
    undefined,
  )
})
