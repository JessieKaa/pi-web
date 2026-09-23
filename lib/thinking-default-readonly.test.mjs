import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { ProjectTrustStore } from "@earendil-works/pi-coding-agent";

// This file runs in its own node:test process. Point the SDK at a sandbox before
// importing rpc-manager so no test can touch the user's Pi settings.
const root = mkdtempSync(join(tmpdir(), "pi-web-thinking-readonly-"));
const agentDir = join(root, "agent");
const cwd = join(root, "cwd");
mkdirSync(agentDir);
mkdirSync(cwd);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;

const settingsPath = join(agentDir, "settings.json");
const baseSettings = { defaultProvider: "fixture", defaultModel: "thinker", defaultThinkingLevel: "low" };
writeFileSync(settingsPath, JSON.stringify(baseSettings));
writeFileSync(join(agentDir, "models.json"), JSON.stringify({
  providers: {
    fixture: {
      baseUrl: "https://example.invalid/v1",
      apiKey: "placeholder",
      api: "openai-completions",
      models: [{
        id: "thinker", name: "Thinker", reasoning: true, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768, maxTokens: 8192,
      }],
    },
  },
}));
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { startRpcSession } = await jiti.import("./rpc-manager.ts");
const { GET: getModels } = await jiti.import("../app/api/models/route.ts");
const { allowFileRoot } = await jiti.import("./file-access.ts");
const { trustProject } = await jiti.import("./project-trust.ts");
const { initialThinkingLevelForModel } = await jiti.import("./model-initial-thinking.ts");
allowFileRoot(cwd);

test.after(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  rmSync(root, { recursive: true, force: true });
});

async function withSession(label, options, run) {
  const { session } = await startRpcSession(`__thinking_test__${label}`, "", cwd, options);
  try {
    await run(session);
  } finally {
    await session.shutdown();
  }
  assert.equal(JSON.parse(readFileSync(settingsPath, "utf8")).defaultThinkingLevel, "low");
}

test("new sessions read the global default without changing it", async () => {
  await withSession("implicit", {}, async (session) => {
    assert.equal((await session.send({ type: "get_state" })).thinkingLevel, "low");
  });
});

test("model API preview follows external global and project settings edits without writing settings", async () => {
  const url = `http://localhost/api/models?cwd=${encodeURIComponent(cwd)}`;
  async function preview() {
    const response = await getModels(new Request(url));
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.deepEqual(
      Object.keys(data.initialThinkingLevels).sort(),
      data.modelList.map((model) => `${model.provider}/${model.id}`).sort(),
    );
    return data.initialThinkingLevels["fixture/thinker"];
  }

  assert.equal(await preview(), "low");
  writeFileSync(settingsPath, JSON.stringify({ ...baseSettings, defaultThinkingLevel: "medium" }));
  const globalBefore = readFileSync(settingsPath, "utf8");
  assert.equal(await preview(), "medium");
  assert.equal(readFileSync(settingsPath, "utf8"), globalBefore);

  const projectDir = join(cwd, ".pi");
  mkdirSync(projectDir);
  const projectSettingsPath = join(projectDir, "settings.json");
  try {
    writeFileSync(projectSettingsPath, JSON.stringify({ defaultThinkingLevel: "high" }));
    trustProject(cwd, agentDir);
    const projectBefore = readFileSync(projectSettingsPath, "utf8");
    assert.equal(await preview(), "high");
    assert.equal(readFileSync(projectSettingsPath, "utf8"), projectBefore);
    const trustStore = new ProjectTrustStore(agentDir);
    trustStore.set(cwd, false);
    assert.equal(await preview(), "medium");
    trustStore.set(cwd, true);
    assert.equal(await preview(), "high");
  } finally {
    rmSync(projectSettingsPath, { force: true });
    writeFileSync(settingsPath, JSON.stringify(baseSettings));
  }
  assert.equal(await preview(), "low");
});

test("preview fallback matches the SDK when no global thinking default is configured", async () => {
  writeFileSync(settingsPath, JSON.stringify({ defaultProvider: "fixture", defaultModel: "thinker" }));
  try {
    const { session } = await startRpcSession("__thinking_test__sdk_fallback", "", cwd);
    try {
      assert.ok(session.inner.model);
      assert.equal(
        initialThinkingLevelForModel(session.inner.model, undefined, undefined, undefined),
        (await session.send({ type: "get_state" })).thinkingLevel,
      );
    } finally {
      await session.shutdown();
    }
  } finally {
    writeFileSync(settingsPath, JSON.stringify(baseSettings));
  }
});

test("explicit startup and live thinking changes stay session-local", async () => {
  await withSession("explicit", { thinkingLevel: "high", initialModel: { provider: "fixture", modelId: "thinker" } }, async (session) => {
    assert.equal((await session.send({ type: "get_state" })).thinkingLevel, "high");
    assert.equal((await session.send({ type: "set_thinking_level", level: "medium" })).level, "medium");
    assert.equal((await session.send({ type: "get_state" })).thinkingLevel, "medium");
  });
});

test("per-model settings override the global default in both preview and SDK startup", async () => {
  writeFileSync(settingsPath, JSON.stringify({
    ...baseSettings,
    modelThinkingLevels: { "fixture/thinker": "medium" },
  }));
  try {
    const response = await getModels(new Request(`http://localhost/api/models?cwd=${encodeURIComponent(cwd)}`));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).initialThinkingLevels["fixture/thinker"], "medium");
    await withSession("model_default", {}, async (session) => {
      assert.equal((await session.send({ type: "get_state" })).thinkingLevel, "medium");
    });
  } finally {
    writeFileSync(settingsPath, JSON.stringify(baseSettings));
  }
});

test("enabledModels thinking pins override the session startup level without changing the default", async () => {
  writeFileSync(settingsPath, JSON.stringify({
    ...baseSettings,
    modelThinkingLevels: { "fixture/thinker": "medium" },
    enabledModels: ["fixture/thinker:high"],
  }));
  const response = await getModels(new Request(`http://localhost/api/models?cwd=${encodeURIComponent(cwd)}`));
  assert.equal(response.status, 200);
  assert.equal((await response.json()).initialThinkingLevels["fixture/thinker"], "high");
  await withSession("pinned", {}, async (session) => {
    assert.equal((await session.send({ type: "get_state" })).thinkingLevel, "high");
  });
});

function appendAssistant(session, text) {
  return session.inner.sessionManager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fixture",
    model: "thinker",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

test("navigate_tree returns the applied live thinking level even for a historical leaf", async () => {
  await withSession(
    "navigate_live_thinking",
    { thinkingLevel: "high", initialModel: { provider: "fixture", modelId: "thinker" } },
    async (session) => {
      const manager = session.inner.sessionManager;
      // Historical leaf on the "high" branch.
      const historicalLeaf = appendAssistant(session, "historical");
      // A newer branch lowers the live level and advances beyond the historical leaf.
      assert.equal((await session.send({ type: "set_thinking_level", level: "low" })).level, "low");
      appendAssistant(session, "latest");
      assert.equal(manager.buildSessionProjection().thinkingLevel, "low");

      const result = await session.send({ type: "navigate_tree", targetId: historicalLeaf });
      assert.equal(result.cancelled, false);
      // The navigated branch persisted "high", but the live session stayed "low".
      // The RPC must report the applied live level, not the branch's stale value.
      assert.equal(manager.buildSessionProjection().thinkingLevel, "high");
      assert.equal(result.thinkingLevel, "low");
      assert.equal(
        result.thinkingLevel,
        (await session.send({ type: "get_state" })).thinkingLevel,
      );
    },
  );
});
