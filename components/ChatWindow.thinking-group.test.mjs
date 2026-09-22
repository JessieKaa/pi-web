import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const chatSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const planSource = await readFile(new URL("../lib/chat-render-plan.ts", import.meta.url), "utf8");

test("renders contiguous completed thinking blocks through the extracted plan", () => {
  assert.match(chatSource, /function ThinkingDetailsGroup\(/);
  assert.match(chatSource, /const thinkingView = item\.segments\.length === 1 \?/);
  assert.match(chatSource, /<ThinkingDetailsGroup segments=\{item\.segments\}/);
  assert.match(planSource, /const flushThinking = \(\) =>/);
  assert.match(planSource, /thinkingSegments\.push\(/);
});

test("nests thinking disclosures inside a tool-process plan item", () => {
  assert.match(planSource, /let hasToolProcess = false;/);
  assert.match(planSource, /if \(hasToolProcess\) \{\s*if \(processChildren\.length === 0\) processKey = `thinking-\$\{thinkingKey\}`;\s*processRefIndex \?\?= thinkingRefIndex;\s*processChildren\.push\(thinking\);/);
  assert.match(chatSource, /<ProcessDetailsGroup messageCount=\{item\.messageCount\}/);
  assert.match(planSource, /if \(!hasToolProcess\) flushProcess\(\);/);
});

test("keeps thinking groups bounded by process and non-assistant messages", () => {
  assert.match(planSource, /if \(processMessage\.role === "custom"\) \{\s*flushThinking\(\);/);
  assert.match(planSource, /if \(processMessage\.role !== "assistant"\) \{\s*flushThinking\(\);/);
  assert.match(planSource, /flushThinking\(\);\s*if \(processChildren\.length === 0\)/);
  assert.match(planSource, /flushThinking\(\);\s*flushProcess\(\);/);
});

test("starts a new group when an extension continues after a final answer", () => {
  assert.match(planSource, /function isConversationSegmentAnchor\(messages: AgentMessage\[\], index: number\)/);
  assert.match(planSource, /message\.role === "custom" && index > 0 && hasFinalAssistantAnswer\(messages\[index - 1\]!\)/);
  assert.match(planSource, /while \(endIndex < messages\.length && !isConversationSegmentAnchor\(messages, endIndex\)\)/);
});

test("leaves only a genuinely streaming live tail ungrouped", () => {
  assert.match(planSource, /const isLiveTail = isStreaming\s*&& hasStreamingContent\s*&& endIndex === messages\.length\s*&& anchorIndex === lastAnchorIndex/);
  assert.doesNotMatch(planSource, /const isLiveTail = \(sessionBusy \|\| streamState\.isStreaming\)/);
  assert.match(planSource, /if \(isLiveTail\) \{\s*for \(let renderIndex = anchorIndex; renderIndex < endIndex; renderIndex\+\+\) rendered\.push\(message\(renderIndex\)\);/);
});
