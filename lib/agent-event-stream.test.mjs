import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createAgentEventStream } = await jiti.import("./agent-event-stream.ts");
const decoder = new TextDecoder();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function readWithin(reader, timeoutMs = 1_000) {
  let timeout;
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Timed out reading SSE chunk")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function decodeData(chunk) {
  const text = decoder.decode(chunk.value);
  assert.match(text, /^data: /);
  return JSON.parse(text.slice("data: ".length));
}

function captureIntervals() {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let callback;
  let cleared = false;

  globalThis.setInterval = (nextCallback) => {
    callback = nextCallback;
    return 1;
  };
  globalThis.clearInterval = () => {
    cleared = true;
  };

  return {
    run() {
      assert.ok(callback, "SSE heartbeat interval was not installed");
      callback();
    },
    get cleared() {
      return cleared;
    },
    restore() {
      globalThis.setInterval = originalSetInterval;
      globalThis.clearInterval = originalClearInterval;
    },
  };
}

test("an absent runtime connects normally without starting, listening, or leasing", async () => {
  const intervals = captureIntervals();
  try {
    const stream = createAgentEventStream(
      new Request("http://localhost/events"),
      "session-id",
      Promise.resolve(null),
    );
    const reader = stream.getReader();

    assert.equal(decoder.decode((await readWithin(reader)).value), ":\n\n");
    assert.deepEqual(decodeData(await readWithin(reader)), {
      type: "connected",
      sessionId: "session-id",
      runtime: "absent",
      isStreaming: false,
    });

    await reader.cancel();
    assert.equal(intervals.cleared, true);
  } finally {
    intervals.restore();
  }
});

test("a passive live stream forwards events but never acquires or renews a lease", async () => {
  const intervals = captureIntervals();
  try {
    let listener;
    let leaseCalls = 0;
    let leaseChecks = 0;
    const stream = createAgentEventStream(
      new Request("http://localhost/events"),
      "session-id",
      Promise.resolve({
        isStreaming: true,
        streamingMessage: undefined,
        onEvent(nextListener) {
          listener = nextListener;
          return () => {};
        },
        setSessionLease() {
          leaseCalls += 1;
        },
        hasActiveSessionLease() {
          leaseChecks += 1;
          return true;
        },
      }),
      "passive",
    );
    const reader = stream.getReader();

    assert.equal(decoder.decode((await readWithin(reader)).value), ":\n\n");
    assert.deepEqual(decodeData(await readWithin(reader)), {
      type: "connected",
      sessionId: "session-id",
      runtime: "live",
      isStreaming: true,
    });
    assert.equal(leaseCalls, 0);

    listener({ type: "agent_start" });
    assert.deepEqual(decodeData(await readWithin(reader)), {
      type: "agent_start",
      promptGeneration: 0,
    });

    intervals.run();
    assert.equal(decoder.decode((await readWithin(reader)).value), ":\n\n");
    assert.deepEqual(decodeData(await readWithin(reader)), { type: "heartbeat" });
    assert.equal(leaseCalls, 0);
    assert.equal(leaseChecks, 0);

    await reader.cancel();
  } finally {
    intervals.restore();
  }
});

test("an active live stream acquires its lease and renews it with heartbeats", async () => {
  const intervals = captureIntervals();
  try {
    let leaseCalls = 0;
    let leaseChecks = 0;
    const stream = createAgentEventStream(
      new Request("http://localhost/events"),
      "session-id",
      Promise.resolve({
        isStreaming: false,
        streamingMessage: undefined,
        onEvent() {
          return () => {};
        },
        setSessionLease() {
          leaseCalls += 1;
        },
        hasActiveSessionLease() {
          leaseChecks += 1;
          return true;
        },
      }),
    );
    const reader = stream.getReader();

    await readWithin(reader); // transport
    assert.deepEqual(decodeData(await readWithin(reader)), {
      type: "connected",
      sessionId: "session-id",
      runtime: "live",
      isStreaming: false,
    });
    assert.equal(leaseCalls, 1);

    intervals.run();
    assert.equal(leaseChecks, 1);
    assert.equal(leaseCalls, 2);
    assert.equal(decoder.decode((await readWithin(reader)).value), ":\n\n");
    assert.deepEqual(decodeData(await readWithin(reader)), { type: "heartbeat" });

    await reader.cancel();
  } finally {
    intervals.restore();
  }
});

test("opens the transport before a slow session is ready and snapshots after subscribing", async () => {
  const startup = deferred();
  const abortController = new AbortController();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "session-id",
    startup.promise,
  );
  const reader = stream.getReader();

  const transport = await readWithin(reader);
  assert.equal(decoder.decode(transport.value), ":\n\n");

  const snapshot = { role: "assistant", content: [{ type: "text", text: "Hello" }] };
  let listener;
  let subscribeCount = 0;
  let unsubscribeCount = 0;
  startup.resolve({
    isStreaming: true,
    streamingMessage: snapshot,
    onEvent(nextListener) {
      subscribeCount += 1;
      listener = nextListener;
      nextListener({
        type: "message_update",
        message: snapshot,
        assistantMessageEvent: { type: "text_delta", delta: "ignored" },
      });
      nextListener({ type: "agent_start" });
      return () => { unsubscribeCount += 1; };
    },
  });

  const connected = decodeData(await readWithin(reader));
  const messageStart = decodeData(await readWithin(reader));
  const replayedEvent = decodeData(await readWithin(reader));
  assert.equal(subscribeCount, 1);
  assert.deepEqual(connected, {
    type: "connected",
    sessionId: "session-id",
    runtime: "live",
    isStreaming: true,
  });
  assert.deepEqual(messageStart, { type: "agent_start", promptGeneration: 0 });
  assert.deepEqual(replayedEvent, { type: "message_start", message: snapshot });

  listener({
    type: "message_update",
    message: { ...snapshot },
    assistantMessageEvent: {
      type: "text_delta",
      delta: "!",
      partial: { ...snapshot },
    },
  });
  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "!" },
    promptGeneration: 0,
  });

  abortController.abort();
  assert.equal(unsubscribeCount, 1);
  assert.equal((await readWithin(reader)).done, true);
});

test("reports a startup failure in-band after opening the transport", async () => {
  const stream = createAgentEventStream(
    new Request("http://localhost/events"),
    "session-id",
    Promise.reject(new Error("broken config")),
  );
  const reader = stream.getReader();

  assert.equal(decoder.decode((await readWithin(reader)).value), ":\n\n");
  assert.deepEqual(decodeData(await readWithin(reader)), {
    type: "startup_error",
    errorMessage: "Failed to start agent: broken config",
  });
  assert.equal((await readWithin(reader)).done, true);
});

test("does not subscribe when the client cancels during startup", async () => {
  const startup = deferred();
  let subscribeCount = 0;
  const stream = createAgentEventStream(
    new Request("http://localhost/events"),
    "session-id",
    startup.promise,
  );
  const reader = stream.getReader();

  await readWithin(reader);
  await reader.cancel();
  startup.resolve({
    isStreaming: false,
    streamingMessage: undefined,
    onEvent() {
      subscribeCount += 1;
      return () => {};
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subscribeCount, 0);
});

test("stamps forwarded events with the session prompt generation", async () => {
  const previous = globalThis.__piPromptGenerations;
  globalThis.__piPromptGenerations = new Map([["session-id", 3]]);
  try {
    const startup = deferred();
    const abortController = new AbortController();
    const stream = createAgentEventStream(
      new Request("http://localhost/events", { signal: abortController.signal }),
      "session-id",
      startup.promise,
    );
    const reader = stream.getReader();
    await readWithin(reader);
    let listener;
    startup.resolve({
      isStreaming: false,
      streamingMessage: undefined,
      onEvent(nextListener) {
        listener = nextListener;
        return () => {};
      },
    });
    await readWithin(reader); // connected
    listener({ type: "prompt_done" });
    assert.deepEqual(decodeData(await readWithin(reader)), {
      type: "prompt_done",
      promptGeneration: 3,
    });
    listener({ type: "agent_end" });
    assert.deepEqual(decodeData(await readWithin(reader)), {
      type: "agent_end",
      promptGeneration: 3,
    });
    abortController.abort();
    assert.equal((await readWithin(reader)).done, true);
  } finally {
    globalThis.__piPromptGenerations = previous;
  }
});

test("closes an already-aborted request and handles a later startup rejection", async () => {
  const abortController = new AbortController();
  abortController.abort();
  const stream = createAgentEventStream(
    new Request("http://localhost/events", { signal: abortController.signal }),
    "session-id",
    Promise.reject(new Error("startup failed after disconnect")),
  );

  assert.equal((await readWithin(stream.getReader())).done, true);
  await new Promise((resolve) => setImmediate(resolve));
});
