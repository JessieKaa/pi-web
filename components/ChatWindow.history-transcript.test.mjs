import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const historySource = source.slice(
  source.indexOf("const HistoryTranscript = memo(function HistoryTranscript"),
  source.indexOf("export function ChatWindow"),
);

test("memoizes the historical transcript and delegates grouping to the pure render plan", () => {
  assert.match(source, /const HistoryTranscript = memo\(function HistoryTranscript\(/);
  assert.match(source, /<HistoryTranscript[\s\S]*?isStreaming=\{streamState\.isStreaming\}[\s\S]*?hasStreamingContent=\{hasStreamingContent\}/);
  assert.doesNotMatch(historySource, /streamingMessage/);
  assert.match(historySource, /const plan = useMemo\(\(\) => buildChatRenderPlan\(/);
  assert.match(historySource, /const rendered = plan\.items\.map\(\(item\) => renderItem\(item\)\)/);
  assert.doesNotMatch(historySource, /splitThinkingBlocks|isConversationSegmentAnchor|findFinalAssistantIndex/);
});

test("keeps transcript loading, source ref ordinals, and branch controls in the memoized renderer", () => {
  assert.match(historySource, /ref=\{sentinelRef\}/);
  assert.match(historySource, /item\.refIndex/);
  assert.match(historySource, /onFork=\{isSubagentMode \|\| sessionBusy \|\| isNew/);
  assert.match(historySource, /onNavigate=\{isSubagentMode \|\| sessionBusy \? undefined : handleNavigate\}/);
  assert.match(historySource, /extractTurnWrittenFiles\(item\.turnContent, toolResultsMap, messageCwd\)/);
});

test("only grows or trims message refs when the historical visible count changes", () => {
  assert.match(source, /const visibleMessageCount = useMemo\(/);
  assert.match(source, /const messageRefs = useMessageRefs\(visibleMessageCount\)/);
  assert.match(source, /if \(refs\.current\.length < count\) \{\s*refs\.current\.push/s);
  assert.match(source, /else if \(refs\.current\.length > count\) \{\s*refs\.current\.length = count;/s);
  assert.doesNotMatch(source, /refs\.current = Array\(count\)/);
});
