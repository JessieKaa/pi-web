import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  createSystemPromptOverride,
  createSystemPromptOverrideExtension,
} from "./system-prompt-override.ts";

// Pi 0.86 renders the prompt from the resource loader and only lets an extension replace it, so
// the whole chat-only / exact-prompt feature hangs off this handler's return value.
async function runHandler(forced) {
  const override = createSystemPromptOverride();
  override.forced = forced;
  let handler;
  createSystemPromptOverrideExtension(override).factory({ on: (event, registered) => { handler = registered; } });
  assert.ok(handler, "the override extension must register a before_agent_start handler");
  return handler({ type: "before_agent_start", prompt: "hi", systemPrompt: "built prompt" }, {});
}

test("chat-only sessions force an empty system prompt", async () => {
  assert.deepEqual(await runHandler(""), { systemPrompt: "" });
});

test("an exact prompt snapshot replaces the built prompt", async () => {
  assert.deepEqual(await runHandler("Work autonomously."), { systemPrompt: "Work autonomously." });
});

test("an unforced session keeps Pi's own prompt untouched", async () => {
  assert.equal(await runHandler(null), undefined);
});

test("the runtime and the host wrapper share one override holder per session", async () => {
  const runtime = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");
  const manager = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  assert.match(runtime, /systemPromptOverride\.forced = promptPlan\.exactSystemPrompt/);
  assert.match(runtime, /extensionFactories: \[createSystemPromptOverrideExtension\(systemPromptOverride\)\]/);
  assert.match(runtime, /chatOnly,\s*\n\s*systemPromptOverride,/);
  assert.match(manager, /setForceEmptySystemPrompt\(force: boolean\): void \{\s*\n\s*this\.forceEmptySystemPrompt = force;\s*\n\s*this\.syncSystemPromptOverride\(\);/);
  assert.doesNotMatch(manager, /agent\.state\.systemPrompt =/);
  assert.doesNotMatch(runtime, /agent\.state\.systemPrompt =/);
});
