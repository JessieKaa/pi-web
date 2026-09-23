import assert from "node:assert/strict";
import test from "node:test";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  appendTitleRequestToTrailingUser,
  buildSessionTitleAgentOptions,
  boundTitleMessages,
  generateSessionTitle,
  parseGeneratedSessionTitle,
  resolveSessionTitleOverride,
  sanitizeTitleMessages,
} = await jiti.import("./session-title.ts");

function assistantMessage(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test-model",
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

// Pi 0.86 normalizes the provider input into a TranscriptContext, so the shadow
// agent's system prompt now arrives as a leading system message. History
// assertions look past it to stay about the conversation itself.
function withoutSystemPrompt(messages) {
  return messages.filter((message, index) => !(index === 0 && message.role === "system"));
}

test("cleans common session title response wrappers", () => {
  assert.equal(parseGeneratedSessionTitle("标题：修复 SSE 重连。"), "修复 SSE 重连");
  assert.equal(parseGeneratedSessionTitle('```json\n{"title":"整理 Session 文件夹"}\n```'), "整理 Session 文件夹");
  assert.equal(parseGeneratedSessionTitle('"Improve worktree session grouping"'), "Improve worktree session grouping");
});

test("rejects responses without a usable title", () => {
  assert.throws(() => parseGeneratedSessionTitle("```\n---\n```"), /usable session title/);
});

test("folds the title request into a trailing user message without mutating the source", () => {
  const source = [
    { role: "assistant", content: [], timestamp: 1 },
    { role: "user", content: [{ type: "text", text: "Fix the running-session race" }], timestamp: 2 },
  ];

  const prepared = appendTitleRequestToTrailingUser(source);

  assert.deepEqual(prepared.map((message) => message.role), ["assistant", "user"]);
  assert.match(prepared[1].content.at(-1).text, /Create a concise title/);
  assert.equal(source[1].content.length, 1);
  assert.notEqual(prepared[1], source[1]);
});

test("leaves a completed conversation unchanged before adding the title turn", () => {
  const source = [
    { role: "user", content: "Fix it", timestamp: 1 },
    { role: "assistant", content: [], timestamp: 2 },
  ];

  assert.equal(appendTitleRequestToTrailingUser(source), source);
});

test("waits for the source reply before sending the title prompt", async () => {
  let sourceReplyFinished = false;
  let providerRoles;
  const sourceAgent = {
    state: {
      systemPrompt: "system",
      model: { provider: "test", id: "test-model" },
      thinkingLevel: "off",
      tools: [],
      messages: [{ role: "user", content: "Implement auto name", timestamp: 1 }],
    },
    waitForIdle: async () => {
      sourceAgent.state.messages.push(assistantMessage("The implementation is complete"));
      sourceReplyFinished = true;
    },
    convertToLlm: (messages) => messages,
    streamFunction: (_model, context) => {
      assert.equal(sourceReplyFinished, true);
      providerRoles = context.messages.map((message) => message.role);
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: assistantMessage("Wait for Complete Agent Reply"),
        });
      });
      return stream;
    },
    sessionId: "source-session-id",
  };

  const result = await generateSessionTitle({ agent: sourceAgent });

  assert.equal(result.title, "Wait for Complete Agent Reply");
  assert.equal(providerRoles[0], "system");
  assert.deepEqual(providerRoles.slice(1), ["user", "assistant", "user"]);
});

test("generates a title when compaction removed all literal user messages", async () => {
  let providerMessages;
  const sourceAgent = {
    state: {
      systemPrompt: "system",
      model: { provider: "test", id: "test-model" },
      thinkingLevel: "off",
      tools: [],
      messages: [
        {
          role: "compactionSummary",
          summary: "The user asked to fix title generation after compaction.",
          tokensBefore: 100_000,
          timestamp: 1,
        },
        assistantMessage("The implementation is complete"),
      ],
    },
    waitForIdle: async () => {},
    convertToLlm,
    streamFunction: (_model, context) => {
      providerMessages = context.messages;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: assistantMessage("Title Generation After Compaction"),
        });
      });
      return stream;
    },
    sessionId: "source-session-id",
  };

  const result = await generateSessionTitle({ agent: sourceAgent });

  assert.equal(result.title, "Title Generation After Compaction");
  const history = withoutSystemPrompt(providerMessages);
  assert.deepEqual(history.map((message) => message.role), ["user", "assistant", "user"]);
  assert.match(history[0].content[0].text, /fix title generation after compaction/);
});

test("temporary title agent preserves the provider-facing prefix", async () => {
  const model = { provider: "test", id: "cached-model" };
  const messages = [{ role: "user", content: [{ type: "text", text: "Fix it" }] }];
  const originalExecute = async () => ({ content: [], details: {} });
  const tools = [{
    name: "read",
    label: "read",
    description: "Read a file",
    parameters: { type: "object", properties: {} },
    execute: originalExecute,
  }];
  const convertToLlm = (value) => value;
  const transformContext = async (value) => value;
  const streamFunction = () => { throw new Error("not called"); };
  const source = {
    state: {
      systemPrompt: "cached system prompt",
      model,
      thinkingLevel: "high",
      tools,
      messages,
    },
    convertToLlm,
    transformContext,
    streamFunction,
    steeringMode: "one-at-a-time",
    followUpMode: "one-at-a-time",
    sessionId: "source-session-id",
    transport: "sse",
    toolExecution: "parallel",
  };

  const options = buildSessionTitleAgentOptions(source);

  assert.equal(options.initialState.systemPrompt, source.state.systemPrompt);
  assert.equal(options.initialState.model, model);
  assert.equal(options.initialState.thinkingLevel, "high");
  assert.equal(options.initialState.messages, messages);
  assert.equal(options.convertToLlm, convertToLlm);
  assert.equal(options.transformContext, transformContext);
  assert.equal(options.streamFn, streamFunction);
  assert.equal(options.sessionId, "source-session-id");
  const withoutExecute = (tool) => Object.fromEntries(
    Object.entries(tool).filter(([key]) => key !== "execute"),
  );
  assert.deepEqual(
    options.initialState.tools.map(withoutExecute),
    tools.map(withoutExecute),
  );
  assert.notEqual(options.initialState.tools[0].execute, originalExecute);
  await assert.rejects(
    options.initialState.tools[0].execute("call", {}, undefined, undefined),
    /cannot be executed/,
  );
});

test("title generation drops tool output and keeps only a short tail", () => {
  const messages = [];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: "user", content: `request ${i} ${"x".repeat(800)}`, timestamp: i });
    messages.push({
      role: "toolResult",
      toolCallId: `call-${i}`,
      toolName: "bash",
      content: [{ type: "text", text: `output ${i} ${"y".repeat(2000)}` }],
      isError: false,
      timestamp: i,
    });
  }
  const bounded = boundTitleMessages(messages);
  assert.equal(bounded.length, 6);
  assert.equal(bounded.some((message) => message.role === "toolResult"), false);
  assert.equal(bounded[0].content.includes("yyyy"), false);
  assert.equal(Array.from(bounded[0].content).length <= 500, true);
});

test("keeps only tool calls with adjacent matching results", () => {
  const messages = [
    { role: "user", content: "inspect both files", timestamp: 1 },
    {
      ...assistantMessage("Inspecting files"),
      content: [
        { type: "text", text: "Inspecting files" },
        { type: "toolCall", id: "call-complete", name: "read", arguments: { path: "a.txt" } },
        { type: "toolCall", id: "call-incomplete", name: "read", arguments: { path: "b.txt" } },
      ],
      stopReason: "toolUse",
    },
    {
      role: "toolResult",
      toolCallId: "call-complete",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: 2,
    },
  ];

  const sanitized = sanitizeTitleMessages(messages);

  assert.deepEqual(
    sanitized[1].content.filter((block) => block.type === "toolCall").map((block) => block.id),
    ["call-complete"],
  );
  assert.equal(sanitized[2], messages[2]);
  assert.equal(messages[1].content.length, 3);
});

test("removes incomplete tool calls before invoking the title provider", async () => {
  let providerMessages;
  const sourceAgent = {
    state: {
      systemPrompt: "system",
      model: { provider: "test", id: "test-model" },
      thinkingLevel: "off",
      tools: [],
      messages: [
        { role: "user", content: "run a command", timestamp: 1 },
        {
          ...assistantMessage(""),
          content: [{
            type: "toolCall",
            id: "call-incomplete",
            name: "bash",
            arguments: { command: "sleep 10" },
          }],
          stopReason: "toolUse",
        },
      ],
    },
    waitForIdle: async () => {},
    convertToLlm: (messages) => messages,
    streamFunction: (_model, context) => {
      providerMessages = context.messages.map((message) => ({
        role: message.role,
        content: message.content,
      }));
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: assistantMessage("Sanitized Tool Call History"),
        });
      });
      return stream;
    },
    sessionId: "source-session-id",
  };

  const result = await generateSessionTitle({ agent: sourceAgent });

  assert.equal(result.title, "Sanitized Tool Call History");
  const history = withoutSystemPrompt(providerMessages);
  assert.deepEqual(history.map((message) => message.role), ["user"]);
  assert.match(history[0].content, /Create a concise title/);
});

test("temporary title agent applies a model/thinking override without changing the source", () => {
  const sourceModel = { provider: "test", id: "source-model" };
  const overrideModel = { provider: "test", id: "title-model" };
  const messages = [{ role: "user", content: [{ type: "text", text: "Fix it" }] }];
  const convertToLlm = (value) => value;
  const source = {
    state: {
      systemPrompt: "cached system prompt",
      model: sourceModel,
      thinkingLevel: "off",
      tools: [],
      messages,
    },
    convertToLlm,
  };

  const options = buildSessionTitleAgentOptions(source, {
    model: overrideModel,
    thinkingLevel: "high",
  });

  assert.equal(options.initialState.model, overrideModel);
  assert.equal(options.initialState.thinkingLevel, "high");
  assert.equal(options.initialState.systemPrompt, source.state.systemPrompt);
  assert.equal(options.initialState.messages, messages);
  assert.equal(options.convertToLlm, convertToLlm);
  // The source Agent is untouched; only the temporary initialState changed.
  assert.equal(source.state.model, sourceModel);
  assert.equal(source.state.thinkingLevel, "off");
});

test("generateSessionTitle sends the override model and thinking level to the title provider", async () => {
  const sourceModel = { provider: "test", id: "source-model" };
  const overrideModel = { provider: "test", id: "title-model" };
  let providerModel;
  let providerReasoning;
  const sourceAgent = {
    state: {
      systemPrompt: "system",
      model: sourceModel,
      thinkingLevel: "off",
      tools: [],
      messages: [{ role: "user", content: "Implement auto name", timestamp: 1 }],
    },
    waitForIdle: async () => {},
    convertToLlm: (messages) => messages,
    streamFunction: (model, _context, options) => {
      providerModel = model;
      providerReasoning = options?.reasoning;
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: assistantMessage("Overridden Title Model"),
        });
      });
      return stream;
    },
    sessionId: "source-session-id",
  };

  const result = await generateSessionTitle(
    { agent: sourceAgent },
    { model: overrideModel, thinkingLevel: "high" },
  );

  assert.equal(result.title, "Overridden Title Model");
  assert.equal(providerModel, overrideModel);
  assert.equal(providerReasoning, "high");
  // No setModel()/setThinkingLevel() is reachable from title generation, so the
  // source session keeps its own model and thinking level (and its JSONL stays clean).
  assert.equal(sourceAgent.state.model, sourceModel);
  assert.equal(sourceAgent.state.thinkingLevel, "off");
});

function fakeModelRuntime(models) {
  return {
    getModel: (provider, modelId) => models.find(
      (model) => model.provider === provider && model.id === modelId,
    ),
    getAvailable: async () => models,
  };
}

test("keeps the source model when no title preference is configured", async () => {
  const resolution = await resolveSessionTitleOverride(null, fakeModelRuntime([]), undefined);
  assert.deepEqual(resolution, {
    usedConfiguredPreference: false,
    fallbackReason: "not-configured",
  });
});

test("resolves a configured title model against the enabled scope", async () => {
  const models = [
    { id: "reasoning-model", provider: "test", name: "Reasoning", reasoning: true },
    { id: "other-model", provider: "test", name: "Other", reasoning: true },
  ];
  const resolution = await resolveSessionTitleOverride(
    { provider: "test", modelId: "reasoning-model", thinkingLevel: "high" },
    fakeModelRuntime(models),
    ["test/reasoning-model"],
  );

  assert.equal(resolution.usedConfiguredPreference, true);
  assert.equal(resolution.override.model, models[0]);
  assert.equal(resolution.override.thinkingLevel, "high");
  assert.equal(resolution.fallbackReason, undefined);
});

test("applies a configured title model without forcing a thinking level", async () => {
  const model = { id: "reasoning-model", provider: "test", name: "Reasoning", reasoning: true };
  const resolution = await resolveSessionTitleOverride(
    { provider: "test", modelId: "reasoning-model" },
    fakeModelRuntime([model]),
    undefined,
  );

  assert.equal(resolution.usedConfiguredPreference, true);
  assert.equal(resolution.override.model, model);
  assert.equal("thinkingLevel" in resolution.override, false);
});

test("falls back when the configured title model is stale", async () => {
  const models = [{ id: "reasoning-model", provider: "test", name: "R", reasoning: true }];
  const resolution = await resolveSessionTitleOverride(
    { provider: "test", modelId: "deleted-model", thinkingLevel: "high" },
    fakeModelRuntime(models),
    undefined,
  );

  assert.equal(resolution.usedConfiguredPreference, false);
  assert.equal(resolution.fallbackReason, "model-not-found");
  assert.equal(resolution.override, undefined);
});

test("falls back when the configured title model is outside enabledModels", async () => {
  const models = [
    { id: "in-scope", provider: "test", name: "In", reasoning: true },
    { id: "out-of-scope", provider: "test", name: "Out", reasoning: true },
  ];
  const resolution = await resolveSessionTitleOverride(
    { provider: "test", modelId: "out-of-scope", thinkingLevel: "high" },
    fakeModelRuntime(models),
    ["test/in-scope"],
  );

  assert.equal(resolution.usedConfiguredPreference, false);
  assert.equal(resolution.fallbackReason, "model-out-of-scope");
  assert.equal(resolution.override, undefined);
});

test("falls back when the configured thinking level is unsupported", async () => {
  const models = [{ id: "non-reasoning", provider: "test", name: "No", reasoning: false }];
  const resolution = await resolveSessionTitleOverride(
    { provider: "test", modelId: "non-reasoning", thinkingLevel: "high" },
    fakeModelRuntime(models),
    undefined,
  );

  assert.equal(resolution.usedConfiguredPreference, false);
  assert.equal(resolution.fallbackReason, "thinking-level-unsupported");
  assert.equal(resolution.override, undefined);
});
