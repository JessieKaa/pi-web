import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const { SUBAGENT_REPORT_PREFIX, createSubagentController, intersectSubagentTools } = await createJiti(import.meta.url).import("./subagent-runtime.ts");

test("a subagent cannot use tools its parent does not have", () => {
  const profileTools = ["read", "bash", "edit", "write"];
  assert.deepEqual(intersectSubagentTools(profileTools, undefined), profileTools, "no parent tool list means the profile decides");
  assert.deepEqual(intersectSubagentTools(profileTools, ["read", "bash"]), ["read", "bash"], "a read-only parent keeps its child read-only");
  assert.deepEqual(intersectSubagentTools(profileTools, []), [], "an empty parent tool list grants nothing");
  assert.deepEqual(intersectSubagentTools(profileTools, ["read", "grep"]), ["read"], "tools the profile lacks are never added");
  assert.deepEqual(profileTools, ["read", "bash", "edit", "write"], "the profile's own list is never mutated");
});

// The helper above is only worth anything if start() actually feeds it the parent's tool list.
test("the child session request is built from the parent's active tools", async () => {
  const source = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");
  assert.match(
    source,
    /const activeTools = intersectSubagentTools\([\s\S]{0,400}?parent\.inner\.getActiveToolNames\?\.\(\)/,
  );
});

function completedRun() {
  return {
    sessionId: "child-session",
    sessionPath: "/tmp/child.jsonl",
    parentSessionId: "parent-session",
    parentToolCallId: "tool-call",
    profile: "Explore",
    description: "Inspect parser",
    task: "Find the parser",
    runInBackground: true,
    status: "completed",
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:01:00.000Z",
    result: "Parser found",
  };
}

test("completion notification reopens an idle parent and uses its current session", async () => {
  const delivered = [];
  const reopened = [];
  let ready = false;
  let parent;
  const liveParent = {
    cwd: "/tmp",
    sessionFile: "/tmp/parent.jsonl",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => { ready = true; },
    inner: {
      sendCustomMessage: async (message, options) => delivered.push({ message, options }),
    },
  };
  const controller = createSubagentController({
    getSession: () => parent,
    registerSession: () => {},
    reopenSession: async (sessionId, sessionFile) => {
      reopened.push([sessionId, sessionFile]);
      parent = liveParent;
      return liveParent;
    },
    resolveSessionPath: async () => "/tmp/parent.jsonl",
    invalidateSessionList: () => {},
  });

  await controller.extensionRuntime.notifyParent(completedRun());

  assert.deepEqual(reopened, [["parent-session", "/tmp/parent.jsonl"]]);
  assert.equal(ready, true);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].message.content, `${SUBAGENT_REPORT_PREFIX}Parser found`);
  assert.equal(delivered[0].message.details.sessionId, "child-session");
  assert.deepEqual(delivered[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("a background result is delivered once, and a collected result is not delivered again", async () => {
  const delivered = [];
  const parent = {
    cwd: "/tmp",
    sessionFile: "/tmp/parent.jsonl",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
    inner: {
      sendCustomMessage: async (message, options) => delivered.push({ message, options }),
    },
  };
  const controller = createSubagentController({
    getSession: () => parent,
    registerSession: () => {},
    reopenSession: async () => parent,
    resolveSessionPath: async () => "/tmp/parent.jsonl",
    invalidateSessionList: () => {},
  });
  const once = { ...completedRun(), sessionId: "child-once" };
  await controller.extensionRuntime.notifyParent(once);
  await controller.extensionRuntime.notifyParent(once);
  assert.equal(delivered.length, 1);

  const collected = { ...completedRun(), sessionId: "child-collected" };
  assert.equal(controller.extensionRuntime.claimResult(collected), true);
  await controller.extensionRuntime.notifyParent(collected);
  await controller.extensionRuntime.notifyParent(collected);
  assert.equal(delivered.length, 1, "a collected result stays claimed across repeated notifications");

  const resumed = { ...once, completedAt: "2026-01-01T00:02:00.000Z", result: "Second result" };
  await controller.extensionRuntime.notifyParent(resumed);
  await controller.extensionRuntime.notifyParent(resumed);
  assert.equal(delivered.length, 2, "a resumed completion on the same session notifies once again");

  const collectedAgain = { ...collected, completedAt: "2026-01-01T00:03:00.000Z" };
  await controller.extensionRuntime.notifyParent(collectedAgain);
  assert.equal(delivered.length, 3, "collecting an earlier completion does not hide a resumed result");
});

test("a failed notification releases its claim so a retry is delivered", async () => {
  const delivered = [];
  let attempts = 0;
  const parent = {
    cwd: "/tmp",
    sessionFile: "/tmp/parent.jsonl",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
    inner: {
      sendCustomMessage: async (message, options) => {
        attempts += 1;
        if (attempts === 1) throw new Error("parent send failed");
        delivered.push({ message, options });
      },
    },
  };
  const controller = createSubagentController({
    getSession: () => parent,
    registerSession: () => {},
    reopenSession: async () => parent,
    resolveSessionPath: async () => "/tmp/parent.jsonl",
    invalidateSessionList: () => {},
  });
  const run = { ...completedRun(), sessionId: "child-retry" };

  await assert.rejects(controller.extensionRuntime.notifyParent(run), /parent send failed/);
  // The send failure must not leave a permanent claim behind.
  await controller.extensionRuntime.notifyParent(run);

  assert.equal(attempts, 2, "the retry must reach sendCustomMessage");
  assert.equal(delivered.length, 1, "the retry delivers the report once");
  assert.equal(delivered[0].message.content, `${SUBAGENT_REPORT_PREFIX}Parser found`);
});

test("concurrent notifications for one child deliver exactly once", async () => {
  const delivered = [];
  let releaseSend;
  let sendStarted;
  const started = new Promise((resolve) => { sendStarted = resolve; });
  const parent = {
    cwd: "/tmp",
    sessionFile: "/tmp/parent.jsonl",
    isAlive: () => true,
    isRunning: () => false,
    waitUntilReady: async () => {},
    inner: {
      sendCustomMessage: async (message, options) => {
        delivered.push({ message, options });
        sendStarted();
        await new Promise((resolve) => { releaseSend = resolve; });
      },
    },
  };
  const controller = createSubagentController({
    getSession: () => parent,
    registerSession: () => {},
    reopenSession: async () => parent,
    resolveSessionPath: async () => "/tmp/parent.jsonl",
    invalidateSessionList: () => {},
  });
  const run = { ...completedRun(), sessionId: "child-concurrent" };

  const first = controller.extensionRuntime.notifyParent(run);
  await started;
  // The second caller must see the in-flight claim and return without a second send.
  await controller.extensionRuntime.notifyParent(run);
  assert.equal(delivered.length, 1, "the in-flight claim suppresses the concurrent caller");

  releaseSend();
  await first;
  // Once delivered, the permanent claim keeps later calls single-shot too.
  await controller.extensionRuntime.notifyParent(run);
  assert.equal(delivered.length, 1, "the delivered result stays claimed");
});

test("disabled built-in subagents reject stale Agent calls before starting", async () => {
  const controller = createSubagentController({
    getSession: () => { throw new Error("must not inspect a parent"); },
    registerSession: () => {},
    reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => false,
  });

  await assert.rejects(
    controller.extensionRuntime.start({
      parentContext: { sessionManager: { getSessionId: () => "parent" } },
      parentToolCallId: "call",
      profile: "explore",
      task: "Inspect",
      description: "Inspect",
    }),
    /built-in sub-agents are disabled/,
  );
});

test("resume reuses the persisted child session and keeps its session id", async () => {
  const calls = [];
  const entries = [
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "old-call",
      profile: "explore",
      description: "old task",
      task: "old",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: [], loadSkills: false, loadExtensions: false },
    } },
    { type: "custom", customType: "pi-web:subagent-result", data: {
      version: 1, status: "completed", completedAt: "2026-01-01T00:01:00.000Z", result: "old result",
    } },
  ];
  const childInner = {
    sessionId: "child",
    sessionFile: "/tmp/child.jsonl",
    sessionManager: { getEntries: () => entries, appendCustomEntry: (type, data) => entries.push({ type: "custom", customType: type, data }) },
    prompt: async (task) => { calls.push(task); },
    getLastAssistantText: () => "new result",
    abort: async () => {},
  };
  const child = { inner: childInner, sessionFile: childInner.sessionFile, cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const delivered = [];
  const parent = { inner: {
    sessionManager: { getSessionId: () => "parent" },
    sendCustomMessage: async (message) => { delivered.push(message); },
  }, sessionFile: "/tmp/parent.jsonl", cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const controller = createSubagentController({
    getSession: (id) => id === "child" ? child : parent,
    registerSession: () => {},
    reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  const oldResult = await controller.extensionRuntime.get("child");
  assert.equal(controller.extensionRuntime.claimResult(oldResult), true);
  const execution = await controller.extensionRuntime.resume({
    parentContext: parent.inner,
    parentToolCallId: "new-call",
    sessionId: "child",
    task: "continue this",
    description: "Continue task",
    runInBackground: true,
  });
  const result = await execution.completion;
  assert.equal(execution.run.sessionId, "child");
  assert.equal(result.sessionId, "child");
  assert.equal(result.status, "completed");
  assert.deepEqual(calls, ["continue this"]);
  await controller.extensionRuntime.notifyParent(result);
  await controller.extensionRuntime.notifyParent(result);
  assert.equal(delivered.length, 1, "a resumed run notifies once after the previous completion was collected");
});

test("resume rejects a child owned by another parent", async () => {
  const controller = createSubagentController({
    getSession: (id) => id === "parent" ? { inner: { sessionManager: { getSessionId: () => "parent" } }, sessionFile: "/tmp/parent.jsonl", cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} } : undefined,
    registerSession: () => {},
    reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  await assert.rejects(controller.extensionRuntime.resume({
    parentContext: { sessionManager: { getSessionId: () => "parent" } },
    parentToolCallId: "call",
    sessionId: "missing",
    task: "continue",
    description: "Continue",
  }), /Subagent not found/);
});

test("two parallel resumes of the same child start it once", async () => {
  const prompts = [];
  let release;
  const entries = [
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "old-call",
      profile: "explore",
      description: "old task",
      task: "old",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: [], loadSkills: false, loadExtensions: false },
    } },
    { type: "custom", customType: "pi-web:subagent-result", data: {
      version: 1, status: "completed", completedAt: "2026-01-01T00:01:00.000Z", result: "old result",
    } },
  ];
  const childInner = {
    sessionId: "child",
    sessionFile: "/tmp/child.jsonl",
    sessionManager: { getEntries: () => entries, appendCustomEntry: (type, data) => entries.push({ type: "custom", customType: type, data }) },
    prompt: async (task) => { prompts.push(task); await new Promise((resolve) => { release = resolve; }); },
    getLastAssistantText: () => "new result",
    abort: async () => {},
  };
  const child = { inner: childInner, sessionFile: childInner.sessionFile, cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const parent = { inner: { sessionManager: { getSessionId: () => "parent" } }, sessionFile: "/tmp/parent.jsonl", cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const controller = createSubagentController({
    getSession: (id) => id === "child" ? child : parent,
    registerSession: () => {},
    reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  const request = {
    parentContext: parent.inner,
    parentToolCallId: "new-call",
    sessionId: "child",
    task: "continue this",
    description: "Continue task",
  };
  // Both callers are in flight together: the status check reads the persisted state
  // while the map is still empty, so only the map can decide which one wins.
  const settled = await Promise.allSettled([
    controller.extensionRuntime.resume(request),
    controller.extensionRuntime.resume(request),
  ]);
  assert.equal(settled.filter((entry) => entry.status === "rejected").length, 1, "exactly one parallel resume must be rejected");
  const execution = settled.find((entry) => entry.status === "fulfilled").value;
  release();
  const result = await execution.completion;
  assert.equal(result.status, "completed");
  assert.deepEqual(prompts, ["continue this"], "the child must be prompted once, not twice");
});

// F8: registration is the one moment a throwing listener can leak a run — the child
// then reports "running" for the life of the process and a waiting parent never wakes.
test("a throwing progress listener cannot leak a run registration", async () => {
  const entries = [
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "old-call",
      profile: "explore",
      description: "old task",
      task: "old",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: [], loadSkills: false, loadExtensions: false },
    } },
    { type: "custom", customType: "pi-web:subagent-result", data: {
      version: 1, status: "completed", completedAt: "2026-01-01T00:01:00.000Z", result: "old result",
    } },
  ];
  const childInner = {
    sessionId: "child-listener",
    sessionFile: "/tmp/child-listener.jsonl",
    sessionManager: { getEntries: () => entries, appendCustomEntry: (type, data) => entries.push({ type: "custom", customType: type, data }) },
    prompt: async () => {},
    getLastAssistantText: () => "new result",
    abort: async () => {},
  };
  const child = { inner: childInner, sessionFile: childInner.sessionFile, cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const parent = { inner: { sessionManager: { getSessionId: () => "parent" } }, sessionFile: "/tmp/parent.jsonl", cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const controller = createSubagentController({
    getSession: (id) => id === childInner.sessionId ? child : parent,
    registerSession: () => {},
    reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  let listenerCalls = 0;
  await assert.rejects(
    controller.extensionRuntime.resume({
      parentContext: parent.inner,
      parentToolCallId: "new-call",
      sessionId: childInner.sessionId,
      task: "continue this",
      description: "Continue task",
      onUpdate: () => {
        listenerCalls += 1;
        throw new Error("listener blew up");
      },
    }),
    /listener blew up/,
  );
  assert.equal(listenerCalls, 1);
  assert.equal(
    controller.listRuns().some((run) => run.sessionId === childInner.sessionId),
    false,
    "the failed registration must be rolled back",
  );
});

// F8 (second half): a listener that throws on a later transition (queue state, running)
// must not fail the child or strand its run — only the initial registration is allowed
// to surface the caller's own error.
test("a listener that throws mid-run cannot fail the child", async () => {
  const entries = [
    { type: "custom", customType: "pi-web:subagent", data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "old-call-2",
      profile: "explore",
      description: "old task",
      task: "old",
      runInBackground: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: [], loadSkills: false, loadExtensions: false },
    } },
    { type: "custom", customType: "pi-web:subagent-result", data: {
      version: 1, status: "completed", completedAt: "2026-01-01T00:01:00.000Z", result: "old result",
    } },
  ];
  const childInner = {
    sessionId: "child-midrun",
    sessionFile: "/tmp/child-midrun.jsonl",
    sessionManager: { getEntries: () => entries, appendCustomEntry: (type, data) => entries.push({ type: "custom", customType: type, data }) },
    prompt: async () => {},
    getLastAssistantText: () => "new result",
    abort: async () => {},
  };
  const child = { inner: childInner, sessionFile: childInner.sessionFile, cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const parent = { inner: { sessionManager: { getSessionId: () => "parent" } }, sessionFile: "/tmp/parent.jsonl", cwd: "/tmp", isAlive: () => true, isRunning: () => false, waitUntilReady: async () => {} };
  const controller = createSubagentController({
    getSession: (id) => id === childInner.sessionId ? child : parent,
    registerSession: () => {},
    reopenSession: async () => child,
    resolveSessionPath: async () => child.sessionFile,
    invalidateSessionList: () => {},
    isBuiltInSubagentsEnabled: () => true,
  });
  let listenerCalls = 0;
  const execution = await controller.extensionRuntime.resume({
    parentContext: parent.inner,
    parentToolCallId: "new-call-2",
    sessionId: childInner.sessionId,
    task: "continue this",
    description: "Continue task",
    // The first call is the registration (which may report the caller's error); every
    // later call is best-effort progress the run must survive.
    onUpdate: () => {
      listenerCalls += 1;
      if (listenerCalls > 1) throw new Error("listener blew up mid-run");
    },
  });
  const result = await execution.completion;
  assert.ok(listenerCalls > 1, "later transitions must still notify the listener");
  assert.equal(result.status, "completed", JSON.stringify({ error: result.error, status: result.status }));
  assert.equal(
    controller.listRuns().some((run) => run.sessionId === childInner.sessionId),
    false,
    "a completed child must not stay registered",
  );
});
