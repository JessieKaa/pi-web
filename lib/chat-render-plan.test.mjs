import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { buildChatRenderPlan, getAssistantMessageOverride } = await jiti.import("./chat-render-plan.ts");

const user = (content = "do the work") => ({ role: "user", content });
const assistant = (content, extra = {}) => ({
  role: "assistant",
  provider: "test",
  model: "test",
  content,
  ...extra,
});
const tool = (id = "call-1") => ({ type: "toolCall", toolCallId: id, toolName: "write", input: { path: "src/a.ts", content: "x" } });
const text = (value) => ({ type: "text", text: value });
const thinking = (value) => ({ type: "thinking", thinking: value });

function plan(messages, options = {}) {
  return buildChatRenderPlan({
    messages,
    entryIds: messages.map((_, index) => `entry-${index}`),
    isStreaming: false,
    sessionId: "session-1",
    ...options,
  });
}

test("describes a completed tool turn without React nodes or tool result input", () => {
  const messages = [
    user(),
    assistant([thinking("inspect"), tool()], { timestamp: 1_000 }),
    assistant([text("Done")], { timestamp: 2_000 }),
  ];
  const result = plan(messages);

  assert.deepEqual(result.items.map((item) => item.kind), ["message", "process", "message"]);
  const process = result.items[1];
  assert.equal(process.kind, "process");
  assert.equal(process.toolCallCount, 1);
  assert.equal(process.messageCount, 1);
  assert.deepEqual(process.children.map((item) => item.kind), ["thinking", "message"]);

  const answer = result.items[2];
  assert.equal(answer.kind, "message");
  assert.deepEqual(answer.assistantBlocks, [text("Done")]);
  assert.deepEqual(answer.turnContent, [thinking("inspect"), tool(), text("Done")]);
  assert.equal(JSON.stringify(result).includes("toolResults"), false);
});

test("keeps persisted process and nested-thinking topology stable while a separate assistant response streams", () => {
  const messages = [
    user(),
    assistant([thinking("inspect"), thinking("plan"), tool()]),
  ];
  const settled = plan(messages);
  const streaming = plan(messages, { isStreaming: true });
  const settledProcess = settled.items[1];
  const streamingProcess = streaming.items[1];

  assert.deepEqual(settled.items.map((item) => item.kind), ["message", "process"]);
  assert.deepEqual(streaming.items.map((item) => item.kind), ["message", "process"]);
  assert.equal(settledProcess.kind, "process");
  assert.equal(streamingProcess.kind, "process");
  if (settledProcess.kind !== "process" || streamingProcess.kind !== "process") return;
  assert.equal(settledProcess.key, streamingProcess.key);
  assert.deepEqual(settledProcess.children.map((item) => item.kind), ["thinking", "message"]);
  assert.deepEqual(streamingProcess.children.map((item) => item.kind), ["thinking", "message"]);
  const settledThinking = settledProcess.children[0];
  const streamingThinking = streamingProcess.children[0];
  assert.equal(settledThinking.kind, "thinking");
  assert.equal(streamingThinking.kind, "thinking");
  if (settledThinking.kind !== "thinking" || streamingThinking.kind !== "thinking") return;
  assert.equal(settledThinking.key, streamingThinking.key);
  assert.equal(settledThinking.segments.length, 2);
  assert.equal(streamingThinking.segments.length, 2);
});

test("keeps the final persisted assistant timestamp hidden while a separate response streams", () => {
  const result = plan([user(), assistant([text("still writing")])], { isStreaming: true });
  const tail = result.items.at(-1);

  assert.equal(tail?.kind, "message");
  if (tail?.kind !== "message") return;
  assert.equal(tail.showTimestamp, false);
});

test("uses compaction and extension continuation messages as independent anchors", () => {
  const messages = [
    { role: "custom", customType: "compaction", content: "summary" },
    assistant([tool("first")]),
    assistant([text("first answer")]),
    { role: "custom", customType: "extension", content: "continue" },
    assistant([tool("second")]),
    assistant([text("second answer")]),
  ];
  const result = plan(messages);

  assert.deepEqual(result.items.map((item) => item.kind), ["message", "process", "message", "message", "process", "message"]);
  assert.equal(result.items[0].kind, "message");
  assert.equal(result.items[3].kind, "message");
  assert.equal(result.items[0].sourceIndex, 0);
  assert.equal(result.items[3].sourceIndex, 3);
});

test("retains source visible-message ordinals for minimap refs through grouping", () => {
  const messages = [
    user(),
    assistant([tool()]),
    { role: "toolResult", toolCallId: "call-1", content: [{ type: "text", text: "ok" }] },
    assistant([text("Done")]),
  ];
  const result = plan(messages);
  const [prompt, process, answer] = result.items;

  assert.equal(prompt.kind, "message");
  assert.equal(prompt.refIndex, 0);
  assert.equal(process.kind, "process");
  assert.equal(process.refIndex, 1);
  assert.equal(answer.kind, "message");
  assert.equal(answer.refIndex, 2);
  assert.equal(result.lastUserMessageIndex, 0);
});

test("caches filtered assistant overrides by entry and content ordinals", () => {
  const message = assistant([thinking("reason"), tool(), text("answer")], { usage: { input: 1 } });
  const first = getAssistantMessageOverride(message, [message.content[1]], true);
  const second = getAssistantMessageOverride(message, [message.content[1]], true);
  const answer = getAssistantMessageOverride(message, [message.content[2]], false);

  assert.equal(first, second);
  assert.notEqual(first, answer);
  assert.equal(first.usage, undefined);
  assert.deepEqual(answer.content, [text("answer")]);
});
