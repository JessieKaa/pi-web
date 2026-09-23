import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { absorbOptimisticUserMessage, userMessageKey } = await createJiti(import.meta.url).import("./prompt-recovery.ts");

function textMessage(content) {
  return { role: "user", content, timestamp: 1 };
}

test("builds stable keys for matching optimistic text messages", () => {
  assert.equal(userMessageKey(textMessage("repeat this")), userMessageKey(textMessage("repeat this")));
  assert.notEqual(userMessageKey(textMessage("first")), userMessageKey(textMessage("second")));
});

test("includes attached images in optimistic message keys", () => {
  const submitted = {
    role: "user",
    content: [
      { type: "text", text: "inspect" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AQID" } },
    ],
    timestamp: 1,
  };
  const differentImage = {
    ...submitted,
    content: [
      { type: "text", text: "inspect" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "BAUG" } },
    ],
  };
  assert.notEqual(userMessageKey(submitted), userMessageKey(differentImage));
});

test("a system message before the user echo does not duplicate the prompt", () => {
  const optimistic = textMessage("\u5bf9\u4e8e\u6211\u4eec\u7684\u667a\u80fd\u52a9\u624b");
  const system = { role: "system", content: "", timestamp: 2 };
  const delivered = { role: "user", content: [{ type: "text", text: optimistic.content }], timestamp: 3 };
  const next = absorbOptimisticUserMessage([optimistic, system], delivered, userMessageKey(optimistic));
  assert.deepEqual(next, [optimistic, system]);
});

test("a later same-text queue delivery still renders", () => {
  const first = textMessage("\u7ee7\u7eed");
  const assistant = { role: "assistant", content: [{ type: "text", text: "ok" }] };
  const delivered = { role: "user", content: [{ type: "text", text: "\u7ee7\u7eed" }], timestamp: 4 };
  const next = absorbOptimisticUserMessage([first, assistant], delivered, null);
  assert.equal(next.length, 3);
  assert.equal(next[2], delivered);
});
