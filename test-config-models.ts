import assert from "node:assert/strict"
import { test } from "node:test"
import { configModelsForProvider } from "./src/index.js"
import { defaultModels } from "./src/models.js"
import type { OpenCodeProvider } from "./src/opencode-types.js"

// Regression guard for PR #7: opencode runs the `provider.models` hook before
// extending the provider DB from config. For plugin-only providers like
// claude-code (absent from the models-dev catalog) that hook bails, so the
// config-path output produced here must carry the real metadata — otherwise
// the context-usage indicator renders 0 / no cost / no model name.

test("configModelsForProvider emits real metadata, not schema defaults", () => {
  const models = configModelsForProvider({}, "claude-code")

  const opus = models["claude-opus-4-8"] as Record<string, unknown>
  assert.ok(opus, "claude-opus-4-8 should be present")

  const limit = opus.limit as { context: number; output: number }
  assert.ok(limit.context > 0, "limit.context must be populated")
  assert.ok(limit.output > 0, "limit.output must be populated")

  const cost = opus.cost as { input: number; output: number }
  assert.ok(cost.input > 0, "cost.input must be populated")
  assert.ok(cost.output > 0, "cost.output must be populated")

  assert.equal(opus.family, "opus")
  assert.equal(opus.name, "Claude Opus 4.8")
  assert.ok(typeof opus.release_date === "string" && opus.release_date.length > 0)
  assert.equal(opus.reasoning, true)

  const variants = opus.variants as Record<string, unknown>
  assert.ok(variants && typeof variants === "object", "variants must be present")
  assert.ok("max" in variants, "default reasoning variants must be carried")
})

test("configModelsForProvider preserves user-defined variants for default models", () => {
  const userConfig = {
    "claude-opus-4-8": { variants: { custom: { reasoningEffort: "low" } } },
  } as unknown as OpenCodeProvider["models"]

  const models = configModelsForProvider(userConfig, "claude-code")
  const variants = (models["claude-opus-4-8"] as Record<string, unknown>)
    .variants as Record<string, unknown>

  // user variant survives the merge...
  assert.ok("custom" in variants, "user-defined variant must be preserved")
  // ...alongside the plugin defaults.
  assert.ok("max" in variants, "default variants must still be present")
})

test("configModelsForProvider passes through user models not in defaults", () => {
  const userConfig = {
    "my-custom-model": { ...defaultModels["claude-opus-4-8"], id: "my-custom-model" },
  } as unknown as OpenCodeProvider["models"]

  const models = configModelsForProvider(userConfig, "claude-code")
  assert.ok(models["my-custom-model"], "user-only model must be emitted")
})
