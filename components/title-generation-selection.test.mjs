import assert from "node:assert/strict";
import test from "node:test";

import {
  buildTitleModelOptions,
  buildTitleProviderOptions,
  buildTitleThinkingOptions,
  changeTitleModel,
  changeTitleProvider,
  changeTitleThinking,
  defaultTitleSelection,
  isTitleModelAvailable,
  normalizeTitlePreference,
  preferenceFromSelection,
  selectionFromPreference,
  titleThinkingLevelsFor,
} from "./title-generation-selection.ts";

const models = {
  modelList: [
    { id: "claude-opus-4", name: "Claude Opus 4", provider: "anthropic" },
    { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
    { id: "gpt-5", name: "GPT-5", provider: "openai" },
  ],
  defaultModel: { provider: "anthropic", modelId: "claude-sonnet-4" },
  thinkingLevels: {
    "anthropic:claude-opus-4": ["off", "low", "high", "xhigh"],
    "anthropic:claude-sonnet-4": ["off", "low", "medium"],
    "openai:gpt-5": ["off", "minimal", "high"],
  },
  thinkingLevelMaps: {
    "anthropic:claude-opus-4": { xhigh: "max" },
    "anthropic:claude-sonnet-4": { medium: null },
    "openai:gpt-5": {},
  },
};

test("filters thinking levels the model maps to null", () => {
  assert.deepEqual(titleThinkingLevelsFor(models, "anthropic", "claude-sonnet-4"), ["off", "low"]);
  assert.deepEqual(titleThinkingLevelsFor(models, "anthropic", "claude-opus-4"), ["off", "low", "high", "xhigh"]);
  assert.deepEqual(titleThinkingLevelsFor(models, "missing", "model"), []);
});

test("defaults to the project default model and a valid thinking level", () => {
  assert.deepEqual(defaultTitleSelection(models), {
    provider: "anthropic",
    modelId: "claude-sonnet-4",
    thinkingLevel: "off",
  });
  assert.equal(defaultTitleSelection({ ...models, modelList: [], defaultModel: null }), null);
});

test("provider change picks the first scoped model and a valid level", () => {
  const selection = { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "low" };
  assert.deepEqual(changeTitleProvider(models, selection, "openai"), {
    provider: "openai",
    modelId: "gpt-5",
    thinkingLevel: "off",
  });
  assert.equal(changeTitleProvider(models, selection, "ghost"), null);
});

test("model change keeps a supported thinking level and falls back otherwise", () => {
  const selection = { provider: "anthropic", modelId: "claude-sonnet-4", thinkingLevel: "low" };
  assert.deepEqual(changeTitleModel(models, selection, "claude-opus-4"), {
    provider: "anthropic",
    modelId: "claude-opus-4",
    thinkingLevel: "low",
  });
  const incompatible = changeTitleModel(models, { ...selection, thinkingLevel: "medium" }, "openai");
  assert.equal(incompatible.thinkingLevel, "off");
});

test("thinking change only swaps the level", () => {
  const selection = { provider: "openai", modelId: "gpt-5", thinkingLevel: "off" };
  assert.deepEqual(changeTitleThinking(selection, "high"), { ...selection, thinkingLevel: "high" });
});

test("keeps a stored provider, model, or level outside the scope visible but not choosable", () => {
  const providerOptions = buildTitleProviderOptions(models, "ghost");
  assert.deepEqual(providerOptions[0], { value: "ghost", label: "ghost", disabled: true });
  assert.deepEqual(providerOptions.slice(1).map((option) => option.value), ["anthropic", "openai"]);

  const modelOptions = buildTitleModelOptions(models, "anthropic", "claude-removed");
  assert.deepEqual(modelOptions[0], { value: "claude-removed", label: "claude-removed", disabled: true });
  assert.deepEqual(modelOptions.slice(1).map((option) => option.value), ["claude-opus-4", "claude-sonnet-4"]);

  const thinkingOptions = buildTitleThinkingOptions(models, "anthropic", "claude-sonnet-4", "medium");
  assert.deepEqual(thinkingOptions[0], { value: "medium", label: "medium", disabled: true });
  assert.deepEqual(thinkingOptions.slice(1).map((option) => option.value), ["off", "low"]);
});

test("does not add a disabled duplicate when the current value is in scope", () => {
  assert.equal(buildTitleProviderOptions(models, "openai").some((option) => option.disabled), false);
  assert.equal(buildTitleModelOptions(models, "openai", "gpt-5").some((option) => option.disabled), false);
  assert.equal(buildTitleThinkingOptions(models, "openai", "gpt-5", "high").some((option) => option.disabled), false);
});

test("normalizes the stored preference wrapper", () => {
  const preference = { version: 1, provider: "openai", modelId: "gpt-5", thinkingLevel: "high" };
  assert.deepEqual(normalizeTitlePreference(preference), preference);
  assert.equal(normalizeTitlePreference(null), null);
  assert.equal(normalizeTitlePreference({ version: 2, provider: "a", modelId: "b", thinkingLevel: "off" }), null);
  assert.equal(normalizeTitlePreference({ version: 1, provider: "", modelId: "b", thinkingLevel: "off" }), null);
  assert.equal(normalizeTitlePreference({ version: 1, provider: "   ", modelId: "b", thinkingLevel: "off" }), null);
  assert.equal(normalizeTitlePreference({ version: 1, provider: "a", modelId: "\t ", thinkingLevel: "off" }), null);
  assert.equal(normalizeTitlePreference({ version: 1, provider: "a", modelId: "b" }), null);
});

test("converts between preference and selection", () => {
  const preference = { version: 1, provider: "openai", modelId: "gpt-5", thinkingLevel: "high" };
  assert.deepEqual(selectionFromPreference(preference), {
    provider: "openai",
    modelId: "gpt-5",
    thinkingLevel: "high",
  });
  assert.deepEqual(preferenceFromSelection({ provider: "openai", modelId: "gpt-5", thinkingLevel: "high" }), preference);
});

test("reports whether the stored model is in scope", () => {
  assert.equal(isTitleModelAvailable(models, "openai", "gpt-5"), true);
  assert.equal(isTitleModelAvailable(models, "openai", "gpt-4"), false);
});
