import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { createAgentEventsHandler } = await jiti.import("./route.ts");

function createHarness({ session, filePath = "/sessions/session.jsonl" } = {}) {
  const calls = { resolve: 0, start: 0, streams: [] };
  const handler = createAgentEventsHandler({
    getRpcSession() { return session; },
    async resolveSessionPath() {
      calls.resolve += 1;
      return filePath;
    },
    async startRpcSession() {
      calls.start += 1;
      return { session: { isStreaming: false, streamingMessage: null, onEvent: () => () => {} } };
    },
    createStream(_req, id, sessionPromise, mode) {
      calls.streams.push({ id, sessionPromise, mode });
      return new ReadableStream();
    },
  });
  const request = (mode) => new Request(`http://localhost/api/agent/session-id/events${mode ? `?mode=${mode}` : ""}`);
  const params = { params: Promise.resolve({ id: "session-id" }) };
  return { calls, handler, request, params };
}

test("passive persisted history returns an absent runtime stream without activation", async () => {
  const { calls, handler, request, params } = createHarness();
  const response = await handler(request("passive"), params);

  assert.equal(response.status, 200);
  assert.equal(calls.resolve, 1);
  assert.equal(calls.start, 0);
  assert.equal(calls.streams.length, 1);
  assert.equal(calls.streams[0].mode, "passive");
  assert.equal(await calls.streams[0].sessionPromise, null);
});

test("active cold history starts exactly the runtime supplied by the dependency", async () => {
  const { calls, handler, request, params } = createHarness();
  const response = await handler(request("active"), params);

  assert.equal(response.status, 200);
  assert.equal(calls.start, 1);
  assert.equal(calls.streams[0].mode, "active");
  assert.equal((await calls.streams[0].sessionPromise).isStreaming, false);
});

test("an existing wrapper is observed without starting again in either mode", async () => {
  const session = { isAlive: () => true, isStreaming: true, streamingMessage: null, onEvent: () => () => {} };
  for (const mode of ["passive", "active"]) {
    const { calls, handler, request, params } = createHarness({ session });
    const response = await handler(request(mode), params);
    assert.equal(response.status, 200);
    assert.equal(calls.resolve, 0);
    assert.equal(calls.start, 0);
    assert.equal(await calls.streams[0].sessionPromise, session);
    assert.equal(calls.streams[0].mode, mode);
  }
});

test("missing sessions and invalid modes never create a runtime", async () => {
  const missing = createHarness({ filePath: null });
  assert.equal((await missing.handler(missing.request("passive"), missing.params)).status, 404);
  assert.equal((await missing.handler(missing.request("active"), missing.params)).status, 404);
  assert.equal(missing.calls.start, 0);

  const invalid = createHarness();
  assert.equal((await invalid.handler(invalid.request("unexpected"), invalid.params)).status, 400);
  assert.equal(invalid.calls.resolve, 0);
  assert.equal(invalid.calls.start, 0);
});

test("omitting mode retains the legacy active activation contract", async () => {
  const { calls, handler, request, params } = createHarness();
  assert.equal((await handler(request(), params)).status, 200);
  assert.equal(calls.start, 1);
  assert.equal(calls.streams[0].mode, "active");
});
