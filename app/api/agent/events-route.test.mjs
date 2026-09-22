import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agentEventsSource = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
const runningEventsSource = await readFile(new URL("./running/events/route.ts", import.meta.url), "utf8");
const agentEventStreamSource = await readFile(new URL("../../../lib/agent-event-stream.ts", import.meta.url), "utf8");

test("agent SSE distinguishes passive observation from explicit active activation", () => {
  assert.match(agentEventsSource, /searchParams\.get\("mode"\)/);
  assert.match(agentEventsSource, /const mode = requestedMode \?\? "active"/);
  assert.match(agentEventsSource, /mode !== "passive" && mode !== "active"/);
  assert.match(agentEventsSource, /status: 400/);
  assert.match(agentEventsSource, /sessionPromise = mode === "active"[\s\S]*?startRpcSession/);
  assert.match(agentEventsSource, /: Promise\.resolve\(null\)/);
  assert.match(agentEventsSource, /dependencies\.createStream\(req, id, sessionPromise, mode\)/);
  assert.doesNotMatch(agentEventsSource, /await startRpcSession\(/);
  assert.match(agentEventsSource, /if \(req\.signal\.aborted\) return new Response\(null, \{ status: 204 \}\)/);
  assert.match(agentEventsSource, /"Cache-Control": "no-cache, no-transform"/);
  assert.match(agentEventsSource, /"X-Accel-Buffering": "no"/);
});

test("SSE routes reuse one TextEncoder per stream", () => {
  for (const source of [agentEventStreamSource, runningEventsSource]) {
    assert.equal((source.match(/new TextEncoder\(\)/g) ?? []).length, 1);
    assert.match(source, /controller\.enqueue\(encoder\.encode\(/);
  }
});
