import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { initialThinkingLevelForModel } = await createJiti(import.meta.url)
  .import("./model-initial-thinking.ts");

const thinkingModel = { reasoning: true };
const limitedModel = { reasoning: true, thinkingLevelMap: { high: null, xhigh: null, max: null } };
const plainModel = { reasoning: false };

test("reads the global default when no model override or scope pin is present", () => {
  assert.equal(initialThinkingLevelForModel(thinkingModel, undefined, undefined, "low"), "low");
  assert.equal(initialThinkingLevelForModel(thinkingModel, undefined, undefined, undefined), "medium");
});

test("scope pin takes precedence over model and global defaults", () => {
  assert.equal(initialThinkingLevelForModel(thinkingModel, "high", "low", "medium"), "high");
  assert.equal(initialThinkingLevelForModel(thinkingModel, undefined, "low", "medium"), "low");
});

test("clamps the preview to the model's supported thinking levels", () => {
  assert.equal(initialThinkingLevelForModel(limitedModel, undefined, undefined, "high"), "medium");
  assert.equal(initialThinkingLevelForModel(plainModel, "high", undefined, "low"), "off");
});
