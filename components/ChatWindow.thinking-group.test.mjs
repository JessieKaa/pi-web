import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

test("folds contiguous completed thinking blocks into one group", () => {
  assert.match(source, /function ThinkingDetailsGroup\(/);
  assert.match(source, /const flushThinking = \(\) =>/);
  assert.match(source, /if \(segments\.length === 1\)/);
  assert.match(source, /<ThinkingDetailsGroup segments=\{segments\}/);
  assert.match(source, /if \(group\.thinking\) \{[\s\S]*?thinkingSegments\.push\(/);
});

test("keeps thinking groups bounded by process and non-assistant messages", () => {
  assert.match(source, /if \(processMessage\.role === "custom"\) \{\s*flushThinking\(\);/);
  assert.match(source, /if \(processMessage\.role !== "assistant"\) \{\s*flushThinking\(\);/);
  assert.match(source, /\} else \{\s*flushThinking\(\);\s*if \(processViews\.length === 0\)/);
  assert.match(source, /flushThinking\(\);\s*flushProcess\(\);/);
});

test("leaves the live tail ungrouped for streaming updates", () => {
  assert.match(source, /if \(isLiveTail\) \{\s*for \(let renderIdx = userIdx; renderIdx < endIdx; renderIdx\+\+\) \{\s*rendered\.push\(renderMessage\(renderIdx\)\);/);
});
