import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { highestThinkingLevel, resolveSessionThinkingLevel, sessionPathHasThinkingLevelChange } = await jiti.import("./thinking-level.ts");

test("highestThinkingLevel picks the strongest advertised level", () => {
  assert.equal(highestThinkingLevel(undefined), "auto");
  assert.equal(highestThinkingLevel([]), "auto");
  assert.equal(highestThinkingLevel(["off"]), "off");
  assert.equal(highestThinkingLevel(["off", "high", "max"]), "max");
  assert.equal(highestThinkingLevel(["low", "medium", "high", "xhigh"]), "xhigh");
});

test("resolveSessionThinkingLevel defaults to auto when every source is absent", () => {
  assert.equal(resolveSessionThinkingLevel({}), "auto");
  assert.equal(resolveSessionThinkingLevel({ live: undefined, persisted: null, promoted: "", fallback: "auto" }), "auto");
});

test("resolveSessionThinkingLevel respects live > persisted > promoted > fallback", () => {
  const all = { live: "max", persisted: "high", promoted: "medium", fallback: "low" };
  assert.equal(resolveSessionThinkingLevel(all), "max");
  assert.equal(resolveSessionThinkingLevel({ ...all, live: undefined }), "high");
  assert.equal(resolveSessionThinkingLevel({ ...all, live: null, persisted: "" }), "medium");
  assert.equal(resolveSessionThinkingLevel({ live: "", persisted: "", promoted: "auto", fallback: "low" }), "low");
});

test("resolveSessionThinkingLevel treats empty and auto as absent signals", () => {
  assert.equal(resolveSessionThinkingLevel({ live: "auto", persisted: "high" }), "high");
  assert.equal(resolveSessionThinkingLevel({ live: "", persisted: "high" }), "high");
  assert.equal(resolveSessionThinkingLevel({ live: "auto", persisted: "auto", promoted: "off" }), "off");
  assert.equal(resolveSessionThinkingLevel({ live: "", persisted: "", promoted: "", fallback: "" }), "auto");
});

test("resolveSessionThinkingLevel preserves off as a real value", () => {
  assert.equal(resolveSessionThinkingLevel({ live: "off", persisted: "high" }), "off");
  assert.equal(resolveSessionThinkingLevel({ persisted: "off", promoted: "medium" }), "off");
  assert.equal(resolveSessionThinkingLevel({ promoted: "off", fallback: "low" }), "off");
  assert.equal(resolveSessionThinkingLevel({ fallback: "off" }), "off");
});

test("resolveSessionThinkingLevel falls through absent higher sources to a lower fallback", () => {
  assert.equal(resolveSessionThinkingLevel({ live: "auto", persisted: undefined, promoted: "", fallback: "minimal" }), "minimal");
  assert.equal(resolveSessionThinkingLevel({ live: null, persisted: null, promoted: null, fallback: "xhigh" }), "xhigh");
});

test("sessionPathHasThinkingLevelChange only follows the active path", () => {
  const entries = [
    { id: "u1", parentId: null, type: "message" },
    { id: "t-alt", parentId: "u1", type: "thinking_level_change" },
    { id: "u2", parentId: "u1", type: "message" },
    { id: "t-main", parentId: "u2", type: "thinking_level_change" },
  ];
  assert.equal(sessionPathHasThinkingLevelChange(entries, "u2"), false);
  assert.equal(sessionPathHasThinkingLevelChange(entries, "t-main"), true);
  assert.equal(sessionPathHasThinkingLevelChange(entries, "t-alt"), true);
});
