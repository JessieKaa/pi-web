import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const historySource = source.slice(
  source.indexOf("const HistoryTranscript = memo(function HistoryTranscript"),
  source.indexOf("export function ChatWindow"),
);

test("memoizes the historical transcript without the streaming message object", () => {
  assert.match(source, /const HistoryTranscript = memo\(function HistoryTranscript\(/);
  assert.match(source, /<HistoryTranscript[\s\S]*?isStreaming=\{streamState\.isStreaming\}[\s\S]*?hasStreamingContent=\{hasStreamingContent\}/);
  assert.doesNotMatch(historySource, /streamingMessage/);
  assert.match(historySource, /const isLiveTail = isStreaming && hasStreamingContent && endIdx === messages\.length && userIdx === lastAnchorIdx/);
});

test("keeps transcript loading, message-ref ordinals, and branch controls in the memoized child", () => {
  assert.match(historySource, /const visibleRefIndexByMessage = new Map<number, number>\(\)/);
  assert.match(historySource, /showSentinel && \(/);
  assert.match(historySource, /ref=\{sentinelRef\}/);
  assert.match(historySource, /onFork=\{isSubagentMode \|\| sessionBusy \|\| isNew/);
  assert.match(historySource, /onNavigate=\{isSubagentMode \|\| sessionBusy \? undefined : handleNavigate\}/);
});

test("only grows or trims message refs when the historical visible count changes", () => {
  assert.match(source, /const visibleMessageCount = useMemo\(/);
  assert.match(source, /const messageRefs = useMessageRefs\(visibleMessageCount\)/);
  assert.match(source, /if \(refs\.current\.length < count\) \{\s*refs\.current\.push/s);
  assert.match(source, /else if \(refs\.current\.length > count\) \{\s*refs\.current\.length = count;/s);
  assert.doesNotMatch(source, /refs\.current = Array\(count\)/);
});
