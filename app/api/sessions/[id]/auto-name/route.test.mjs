import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";

// readTitleGenerationPreference() resolves ~/.pi/agent/settings.json through
// PI_CODING_AGENT_DIR, so point it at a throwaway dir before importing the route.
const agentDir = mkdtempSync(join(tmpdir(), "pi-web-auto-name-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const settingsPath = join(agentDir, "settings.json");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { createAutoNamePost } = await jiti.import("./route.ts");

const sourceModel = { provider: "test", id: "source-model" };
const overrideModel = { provider: "test", id: "title-model", name: "Title", reasoning: true };

const validPreference = {
  version: 1,
  provider: "test",
  modelId: "title-model",
  thinkingLevel: "high",
};

function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "title-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * In-memory session wrapper whose agent streams a title through the same
 * provider seam the production session uses, while recording the model the
 * temporary title agent actually requested.
 */
function makeSession({ enabledModels } = {}) {
  const streamed = [];
  const agent = {
    state: {
      systemPrompt: "system",
      model: sourceModel,
      thinkingLevel: "off",
      tools: [],
      messages: [{ role: "user", content: "Name this session", timestamp: 1 }],
    },
    waitForIdle: async () => {},
    convertToLlm: (messages) => messages,
    streamFunction: (model, _context, options) => {
      streamed.push({ model, reasoning: options?.reasoning });
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({ type: "done", reason: "stop", message: assistantMessage("Configured Title") });
      });
      return stream;
    },
    sessionId: "source-session-id",
  };
  const modelRuntime = {
    getModel: (provider, modelId) => (
      [sourceModel, overrideModel].find((model) => model.provider === provider && model.id === modelId)
    ),
    getAvailable: async () => [sourceModel, overrideModel],
  };
  const sessionName = { value: undefined };
  const wrapper = {
    isAlive: () => true,
    waitUntilReady: async () => {},
    inner: {
      agent,
      modelRuntime,
      settingsManager: { getEnabledModels: () => enabledModels },
      setSessionName: (name) => { sessionName.value = name; },
    },
  };
  return { wrapper, streamed, sessionName };
}

function makeDeps(wrapper) {
  return {
    resolveSessionPath: async () => "/tmp/session.jsonl",
    getRpcSession: () => undefined,
    startRpcSession: async () => ({ session: wrapper }),
    invalidateSessionListCache: () => {},
  };
}

function post(deps, id = "session-1") {
  const POST = createAutoNamePost(deps);
  return POST(
    new Request(`http://127.0.0.1:30141/api/sessions/${id}/auto-name`, { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );
}

test("persisted title preference flows through auto-name into title generation", async () => {
  writeFileSync(settingsPath, JSON.stringify({ piWeb: { titleGeneration: validPreference } }));
  const { wrapper, streamed, sessionName } = makeSession({ enabledModels: ["test/title-model"] });

  const response = await post(makeDeps(wrapper));
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.titleGeneration.usedConfiguredPreference, true);
  assert.equal(body.titleGeneration.fallbackReason, undefined);
  assert.equal(body.title, "Configured Title");
  assert.equal(sessionName.value, "Configured Title");
  // The temporary title agent streamed with the configured model and thinking
  // level, proving the awaited preference reached resolveSessionTitleOverride.
  assert.deepEqual(streamed, [{ model: overrideModel, reasoning: "high" }]);
});

test("malformed persisted settings enter the fallback path without an unhandled rejection", async () => {
  writeFileSync(settingsPath, "{ not json");
  const { wrapper, streamed } = makeSession({ enabledModels: ["test/title-model"] });

  const response = await post(makeDeps(wrapper));
  assert.equal(response.status, 200);
  const body = await response.json();

  assert.equal(body.titleGeneration.usedConfiguredPreference, false);
  assert.equal(body.titleGeneration.fallbackReason, "resolution-failed");
  // Falls back to the source session model rather than failing the request.
  assert.deepEqual(streamed, [{ model: sourceModel, reasoning: undefined }]);
});

test("out-of-scope persisted preference falls back with a resolver reason", async () => {
  writeFileSync(settingsPath, JSON.stringify({ piWeb: { titleGeneration: validPreference } }));
  const { wrapper, streamed } = makeSession({ enabledModels: ["test/source-model"] });

  const body = await (await post(makeDeps(wrapper))).json();

  assert.equal(body.titleGeneration.usedConfiguredPreference, false);
  assert.equal(body.titleGeneration.fallbackReason, "model-out-of-scope");
  assert.deepEqual(streamed, [{ model: sourceModel, reasoning: undefined }]);
});
