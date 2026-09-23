import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const listRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const detailRoute = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
const contextRoute = await readFile(new URL("./[id]/context/route.ts", import.meta.url), "utf8");
const stateRoute = await readFile(new URL("./[id]/state/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: getSessionDetail, DELETE: deleteSession } = await jiti.import("./[id]/route.ts");
const { GET: getSessionContext } = await jiti.import("./[id]/context/route.ts");
const { GET: getSessionState } = await jiti.import("./[id]/state/route.ts");
const { cacheSessionPath } = await jiti.import("../../../lib/session-reader.ts");

test("session listing merges live registry snapshots and honors force refresh", () => {
  assert.match(listRoute, /searchParams\.get\("force"\) === "1"/);
  assert.match(listRoute, /listAllSessions\(\{ force \}\)/);
  assert.match(listRoute, /attachSessionProjectInfo\(getRpcSessionInfos\(\)\)/);
  assert.match(listRoute, /jsonResponse\(/);
  assert.match(detailRoute, /jsonResponse\(req,/);
  assert.match(listRoute, /mergeSessionLists\(persistedSessions, runtimeSessions\)/);
  assert.match(listRoute, /"Cache-Control": "no-store"/);
});

test("idle session reads window jsonl without SessionManager.open", () => {
  for (const source of [detailRoute, contextRoute]) {
    const liveLookup = source.indexOf("getRpcSession(id)");
    const pathLookup = source.indexOf("resolveSessionPath(id)");
    assert.ok(liveLookup >= 0);
    assert.ok(pathLookup > liveLookup);
    assert.match(source, /readSessionWindow/);
  }
  assert.doesNotMatch(detailRoute, /SessionManager\.open\(resolvedPath/);
  assert.doesNotMatch(contextRoute, /SessionManager\.open/);
  assert.match(detailRoute, /leafId: leafIdParam/);
  assert.doesNotMatch(detailRoute, /listInfo\?\.messageCount \|\|/);
});

test("live agent state is available before the session file is persisted", () => {
  const liveLookup = stateRoute.indexOf("getRpcSession(id)");
  const pathLookup = stateRoute.indexOf("resolveSessionPath(id)");
  assert.ok(liveLookup >= 0);
  assert.ok(pathLookup > liveLookup);
  assert.match(stateRoute, /if \(rpc\?\.isAlive\(\)\)/);
});

test("live detail and state routes work without a persisted JSONL file", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const id = "live-route-test";
  const timestamp = "2026-08-12T01:02:03.000Z";
  const entry = {
    type: "message",
    id: "u1",
    parentId: null,
    timestamp,
    message: { role: "user", content: "hello live" },
  };
  const sessionManager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp", timestamp }),
    getEntries: () => [entry],
    getLeafId: () => entry.id,
    getTree: () => [],
    getSessionName: () => undefined,
    getSessionFile: () => `/tmp/pi-web-live-route-not-persisted-${process.pid}.jsonl`,
  };
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => true,
    inner: { sessionManager },
    sessionFile: sessionManager.getSessionFile(),
    sessionId: id,
    cwd: "/tmp",
    send: async () => ({ isStreaming: true }),
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const routeContext = { params: Promise.resolve({ id }) };
  const detailResponse = await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}`),
    routeContext,
  );
  const stateResponse = await getSessionState(
    new Request(`http://localhost/api/sessions/${id}/state`),
    routeContext,
  );
  const detail = await detailResponse.json();

  assert.equal(detailResponse.status, 200);
  assert.equal(detail.info.transient, true);
  assert.deepEqual(detail.context.messages.map((message) => message.content), ["hello live"]);
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), {
    running: true,
    state: { isStreaming: true },
  });
});

test("a live session with a file reads message windows from disk", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-live-file-"));
  const id = "live-file-route-test";
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({
    type: "session", version: 3, id, timestamp: "2026-08-14T00:00:00.000Z", cwd: dir,
  })}\n${JSON.stringify({
    type: "message", id: "m1", parentId: null, timestamp: "2026-08-14T00:00:01.000Z",
    message: { role: "user", content: "from file" },
  })}\n`);
  cacheSessionPath(id, path);
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    inner: { sessionManager: {
      getSessionFile: () => path,
      getSessionName: () => "live name",
      getEntries: () => [],
      getTree: () => [],
    } },
    sessionFile: path,
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const detail = await (await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}`),
    { params: Promise.resolve({ id }) },
  )).json();
  assert.equal(detail.context.messages[0].content, "from file");
  assert.equal(detail.info.name, "live name");

  const { GET: getSessionContext } = await jiti.import("./[id]/context/route.ts");
  const context = await (await getSessionContext(
    new Request(`http://localhost/api/sessions/${id}/context`),
    { params: Promise.resolve({ id }) },
  )).json();
  assert.equal(context.context.messages[0].content, "from file");
});

test("live file windows follow the active branch instead of the last JSONL entry", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-live-leaf-"));
  const id = "live-leaf-route-test";
  const path = join(dir, `${id}.jsonl`);
  const timestamp = "2026-08-14T00:00:00.000Z";
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: "root" } },
    { type: "message", id: "a1", parentId: "u1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "selected" }] } },
    { type: "message", id: "u2", parentId: "u1", timestamp, message: { role: "user", content: "other branch" } },
  ];
  writeFileSync(path, `${[JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: dir }), ...entries.map(JSON.stringify)].join("\n")}\n`);
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    sessionFile: path,
    inner: { sessionManager: {
      getSessionFile: () => path,
      getSessionName: () => undefined,
      getLeafId: () => "a1",
      getEntries: () => entries,
      getTree: () => [],
    } },
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
    rmSync(dir, { recursive: true, force: true });
  });
  for (const history of ["context", "transcript"]) {
    const detail = await (await getSessionDetail(
      new Request(`http://localhost/api/sessions/${id}?history=${history}`),
      { params: Promise.resolve({ id }) },
    )).json();
    assert.equal(detail.leafId, "a1");
    assert.deepEqual(detail.context.entryIds, ["u1", "a1"]);
    const context = await (await getSessionContext(
      new Request(`http://localhost/api/sessions/${id}/context?history=${history}`),
      { params: Promise.resolve({ id }) },
    )).json();
    assert.equal(context.leafId, "a1");
    assert.deepEqual(context.context.entryIds, ["u1", "a1"]);
  }
});

test("live JSONL windows fall back to the in-memory leaf and cursor before flush", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-live-unflushed-"));
  const id = "live-unflushed-route-test";
  const path = join(dir, `${id}.jsonl`);
  const timestamp = "2026-08-14T00:00:00.000Z";
  const root = { type: "message", id: "u1", parentId: null, timestamp, message: { role: "user", content: "persisted" } };
  const answer = { type: "message", id: "a1", parentId: "u1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "unflushed" }] } };
  const sibling = { type: "message", id: "b1", parentId: "u1", timestamp, message: { role: "user", content: "another unflushed branch" } };
  writeFileSync(path, `${JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: dir })}\n${JSON.stringify(root)}\n`);
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    sessionFile: path,
    inner: { sessionManager: {
      getSessionFile: () => path,
      getSessionName: () => undefined,
      getLeafId: () => "a1",
      getEntries: () => [root, answer, sibling],
      getHeader: () => ({ type: "session", version: 3, id, timestamp, cwd: dir }),
      getTree: () => [],
    } },
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
    rmSync(dir, { recursive: true, force: true });
  });
  const params = { params: Promise.resolve({ id }) };
  for (const history of ["context", "transcript"]) {
    const detail = await (await getSessionDetail(new Request(`http://localhost/api/sessions/${id}?history=${history}`), params)).json();
    assert.equal(detail.leafId, "a1", `${history} must use the live leaf`);
    assert.deepEqual(detail.context.entryIds, ["u1", "a1"], `${history} must include the unflushed reply`);
    const context = await (await getSessionContext(new Request(`http://localhost/api/sessions/${id}/context?history=${history}`), params)).json();
    assert.equal(context.leafId, "a1");
    assert.deepEqual(context.context.entryIds, ["u1", "a1"]);
  }
  const siblingContext = await getSessionContext(new Request(`http://localhost/api/sessions/${id}/context?leafId=b1`), params);
  assert.deepEqual((await siblingContext.json()).context.entryIds, ["u1", "b1"], "explicit branch selection must use the unflushed leaf");
  const older = await getSessionContext(new Request(`http://localhost/api/sessions/${id}/context?history=transcript&before=a1`), params);
  assert.equal(older.status, 200);
  assert.deepEqual((await older.json()).context.entryIds, ["u1"]);
  const stale = await getSessionContext(new Request(`http://localhost/api/sessions/${id}/context?history=transcript&before=rewritten`), params);
  assert.equal(stale.status, 409);
});

test("live file windows use complete runtime timing and branch metadata", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-live-metadata-"));
  const id = "live-metadata-route-test";
  const path = join(dir, `${id}.jsonl`);
  const timestamp = "2026-08-14T00:00:00.000Z";
  const start = Date.parse(timestamp);
  const entries = Array.from({ length: 1000 }, (_, index) => ({
    type: "message",
    id: `m${index}`,
    parentId: index ? `m${index - 1}` : null,
    timestamp: new Date(start + index * 1000).toISOString(),
    message: index % 2
      ? { role: "assistant", content: [{ type: "text", text: "answer" }] }
      : { role: "user", content: "x".repeat(1800) },
  }));
  writeFileSync(path, `${[JSON.stringify({ type: "session", version: 3, id, timestamp, cwd: dir }), ...entries.map(JSON.stringify)].join("\n")}\n`);
  const fullTree = [{ entry: entries[0], children: [] }];
  let entryScans = 0;
  let treeBuilds = 0;
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    sessionFile: path,
    inner: { sessionManager: {
      getSessionFile: () => path,
      getSessionName: () => undefined,
      getLeafId: () => entries.at(-1).id,
      getEntries: () => { entryScans++; return entries; },
      getTree: () => { treeBuilds++; return fullTree; },
    } },
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
    rmSync(dir, { recursive: true, force: true });
  });
  const response = await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}`),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(response.status, 200);
  const detail = await response.json();
  assert.equal(detail.totalActiveMs, 500_000);
  assert.equal(detail.info.messageCount, 1000);
  assert.equal(detail.info.firstMessage, "x".repeat(200));
  assert.equal(detail.tree[0].entry.id, "m0");
  assert.equal(detail.hasMore, true);
  assert.equal(detail.context.entryIds.at(-1), "m999");
  const repeat = await getSessionDetail(new Request(`http://localhost/api/sessions/${id}`), { params: Promise.resolve({ id }) });
  assert.equal(repeat.status, 200);
  assert.equal(entryScans, 1, "unchanged JSONL should reuse complete live metadata");
  assert.equal(treeBuilds, 1, "unchanged JSONL should not rebuild the full tree");
  const appended = { type: "message", id: "m1000", parentId: "m999", timestamp: new Date(start + 1_000_000).toISOString(), message: { role: "user", content: "new" } };
  entries.push(appended);
  writeFileSync(path, `${JSON.stringify(appended)}\n`, { flag: "a" });
  const updated = await (await getSessionDetail(new Request(`http://localhost/api/sessions/${id}`), { params: Promise.resolve({ id }) })).json();
  assert.equal(updated.info.messageCount, 1001);
  assert.equal(entryScans, 2, "appending JSONL should invalidate the live metadata cache");
  assert.equal(treeBuilds, 2);
});

test("idle session state does not start a runtime", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-idle-state-"));
  const id = "idle-state-test";
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({
    type: "session", version: 3, id, timestamp: "2026-08-14T00:00:00.000Z", cwd: dir,
  })}\n`);
  cacheSessionPath(id, path);
  globalThis.__piSessions = new Map();
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const response = await getSessionState(
    new Request(`http://localhost/api/sessions/${id}/state`),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { running: false });
});

test("delete of an unknown session still returns 404", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  globalThis.__piSessions = new Map();
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const response = await deleteSession(
    new Request("http://localhost/api/sessions/00000000-0000-0000-0000-000000000000", { method: "DELETE" }),
    { params: Promise.resolve({ id: "00000000-0000-0000-0000-000000000000" }) },
  );
  assert.equal(response.status, 404);
});

test("delete shuts down a transient session that has no file yet", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const id = "transient-delete-test";
  const calls = [];
  globalThis.__piSessions = new Map([
    [id, { isAlive: () => true, shutdown: async () => { calls.push("shutdown"); } }],
  ]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["shutdown"]);
});

test("delete refuses when the cached path does not belong to the requested id", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-session-mismatch-"));
  const otherId = "some-other-session";
  const path = join(dir, `${otherId}.jsonl`);
  writeFileSync(path, `${JSON.stringify({
    type: "session", version: 3, id: otherId, timestamp: "2026-08-14T00:00:00.000Z", cwd: dir,
  })}\n`);
  const requestedId = "requested-session";
  cacheSessionPath(requestedId, path);
  globalThis.__piSessions = new Map();
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${requestedId}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: requestedId }) },
  );
  assert.equal(response.status, 404);
  assert.ok(existsSync(path), "mismatched file must not be unlinked");
});

test("rename goes through the live wrapper when one exists", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-session-rename-"));
  const id = "rename-live-test";
  const path = join(dir, `${id}.jsonl`);
  writeFileSync(path, `${JSON.stringify({
    type: "session", version: 3, id, timestamp: "2026-08-14T00:00:00.000Z", cwd: dir,
  })}\n`);
  cacheSessionPath(id, path);
  const sent = [];
  globalThis.__piSessions = new Map([
    [id, { isAlive: () => true, send: async (command) => { sent.push(command); return null; } }],
  ]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const { PATCH: patchSession } = await jiti.import("./[id]/route.ts");
  const response = await patchSession(
    new Request(`http://localhost/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new name" }),
    }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(sent, [{ type: "set_session_name", name: "new name" }]);
  assert.doesNotMatch(readFileSync(path, "utf8"), /session_info/);
});

test("rename into the reserved subagent namespace is rejected with 409", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const id = "rename-into-reserved-test";
  const sent = [];
  globalThis.__piSessions = new Map([
    [id, {
      isAlive: () => true,
      inner: { sessionManager: { getSessionName: () => "Main task" } },
      send: async (command) => { sent.push(command); return null; },
    }],
  ]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const { PATCH: patchSession } = await jiti.import("./[id]/route.ts");
  const response = await patchSession(
    new Request(`http://localhost/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "subagent-worker-317e1ca0-1" }),
    }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(response.status, 409);
  assert.deepEqual(sent, []);
});

test("rename out of the reserved subagent namespace is rejected with 409", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-session-rename-reserved-"));
  const id = "rename-out-of-reserved-test";
  const path = join(dir, `${id}.jsonl`);
  const original = [
    JSON.stringify({
      type: "session", version: 3, id, timestamp: "2026-08-14T00:00:00.000Z", cwd: dir,
    }),
    JSON.stringify({
      type: "session_info", id: "si1", parentId: null, timestamp: "2026-08-14T00:00:00.000Z",
      name: "subagent-worker-317e1ca0-1",
    }),
    "",
  ].join("\n");
  writeFileSync(path, original);
  cacheSessionPath(id, path);
  globalThis.__piSessions = new Map();
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const { PATCH: patchSession } = await jiti.import("./[id]/route.ts");
  const response = await patchSession(
    new Request(`http://localhost/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "ordinary name" }),
    }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(response.status, 409);
  assert.equal(readFileSync(path, "utf8"), original, "file must be untouched");
});

test("delete shuts down live child sessions before rewriting their files", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-session-delete-"));
  const parentId = "parent-delete-test";
  const childId = "child-delete-test";
  const parentPath = join(dir, `${parentId}.jsonl`);
  const childPath = join(dir, `${childId}.jsonl`);
  writeFileSync(parentPath, `${JSON.stringify({
    type: "session", version: 3, id: parentId, timestamp: "2026-08-14T00:00:00.000Z", cwd: dir,
  })}\n`);
  writeFileSync(childPath, `${JSON.stringify({
    type: "session", version: 3, id: childId, timestamp: "2026-08-14T00:00:01.000Z", cwd: dir,
    parentSession: parentPath,
  })}\n${JSON.stringify({
    type: "message", id: "m1", parentId: null, timestamp: "2026-08-14T00:00:02.000Z",
    message: { role: "user", content: "keep me" },
  })}\n`);
  cacheSessionPath(parentId, parentPath);
  cacheSessionPath(childId, childPath);

  const order = [];
  globalThis.__piSessions = new Map([
    [childId, { isAlive: () => true, shutdown: async () => { order.push("child-shutdown"); } }],
    [parentId, { isAlive: () => true, shutdown: async () => { order.push("parent-shutdown"); } }],
  ]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${parentId}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: parentId }) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(order, ["child-shutdown", "parent-shutdown"]);
  const childHeader = JSON.parse(readFileSync(childPath, "utf8").split("\n")[0]);
  assert.equal(childHeader.parentSession, undefined);
  assert.match(readFileSync(childPath, "utf8"), /keep me/);
});

test("delete of a cached path whose file is gone still shuts down the live wrapper", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-session-missing-"));
  const id = "missing-file-delete-test";
  const path = join(dir, `${id}.jsonl`);
  cacheSessionPath(id, path);
  const calls = [];
  globalThis.__piSessions = new Map([
    [id, { isAlive: () => true, shutdown: async () => { calls.push("shutdown"); } }],
  ]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ["shutdown"]);
});

test("delete removes subagent descendants and reparents conversation forks", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-session-subagent-delete-"));
  const parentId = "parent-subagent-delete";
  const subagentId = "child-subagent-delete";
  const forkId = "child-fork-delete";
  const parentPath = join(dir, `${parentId}.jsonl`);
  const subagentPath = join(dir, `${subagentId}.jsonl`);
  const forkPath = join(dir, `${forkId}.jsonl`);
  writeFileSync(parentPath, `${JSON.stringify({
    type: "session", version: 3, id: parentId, timestamp: "2026-08-14T00:00:00.000Z", cwd: dir,
  })}\n`);
  writeFileSync(subagentPath, `${JSON.stringify({
    type: "session", version: 3, id: subagentId, timestamp: "2026-08-14T00:00:01.000Z", cwd: dir,
    parentSession: parentPath,
  })}\n${JSON.stringify({
    type: "session_info", id: "si1", parentId: null, timestamp: "2026-08-14T00:00:01.500Z",
    name: "subagent-worker-317e1ca0-1",
  })}\n`);
  writeFileSync(forkPath, `${JSON.stringify({
    type: "session", version: 3, id: forkId, timestamp: "2026-08-14T00:00:02.000Z", cwd: dir,
    parentSession: parentPath,
  })}\n${JSON.stringify({
    type: "message", id: "m1", parentId: null, timestamp: "2026-08-14T00:00:03.000Z",
    message: { role: "user", content: "keep fork" },
  })}\n`);
  cacheSessionPath(parentId, parentPath);
  cacheSessionPath(subagentId, subagentPath);
  cacheSessionPath(forkId, forkPath);

  const order = [];
  globalThis.__piSessions = new Map([
    [subagentId, { isAlive: () => true, shutdown: async () => { order.push("subagent-shutdown"); } }],
    [forkId, { isAlive: () => true, shutdown: async () => { order.push("fork-shutdown"); } }],
    [parentId, { isAlive: () => true, shutdown: async () => { order.push("parent-shutdown"); } }],
  ]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${parentId}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: parentId }) },
  );
  assert.equal(response.status, 200);
  assert.equal(existsSync(parentPath), false);
  assert.equal(existsSync(subagentPath), false);
  assert.equal(existsSync(forkPath), true);
  const forkHeader = JSON.parse(readFileSync(forkPath, "utf8").split("\n")[0]);
  assert.equal(forkHeader.parentSession, undefined);
  assert.equal(order.at(-1), "parent-shutdown");
  assert.deepEqual(new Set(order.slice(0, -1)), new Set(["subagent-shutdown", "fork-shutdown"]));
});

test("session listing caps firstMessage without mutating the source", async () => {
  const { compactSessionForList } = await jiti.import("./route.ts");
  const source = {
    id: "long",
    path: "/tmp/long.jsonl",
    cwd: "/tmp",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "x".repeat(2_000),
  };

  const compact = compactSessionForList(source);
  assert.equal(compact.firstMessage.length, 200);
  assert.equal(source.firstMessage.length, 2_000);
  assert.equal(compactSessionForList({ ...source, firstMessage: "short" }).firstMessage, "short");
});

test("idle session detail windows messages and pages with before", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-window-route-"));
  const id = "window-route-test";
  const path = join(dir, `${id}.jsonl`);
  const lines = [{
    type: "session", version: 3, id, timestamp: "2026-08-14T00:00:00.000Z", cwd: dir,
  }];
  let parent = null;
  for (let i = 1; i <= 12; i++) {
    const entryId = `m${i}`;
    lines.push({
      type: "message",
      id: entryId,
      parentId: parent,
      timestamp: `2026-08-14T00:00:${String(i).padStart(2, "0")}.000Z`,
      message: { role: "user", content: `msg ${i}` },
    });
    parent = entryId;
  }
  writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  cacheSessionPath(id, path);
  globalThis.__piSessions = new Map();
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const routeContext = { params: Promise.resolve({ id }) };
  const first = await (await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}?limit=4`),
    routeContext,
  )).json();
  assert.deepEqual(first.context.messages.map((message) => message.content), ["msg 9", "msg 10", "msg 11", "msg 12"]);
  assert.equal(first.hasMore, true);

  const older = await (await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}?limit=4&before=${first.context.entryIds[0]}`),
    routeContext,
  )).json();
  assert.deepEqual(older.context.messages.map((message) => message.content), ["msg 5", "msg 6", "msg 7", "msg 8"]);
  assert.equal(older.hasMore, true);
  assert.equal(first.info.messageCount, 12);

  const sidePath = join(dir, `${id}-side.jsonl`);
  writeFileSync(sidePath, `${JSON.stringify({
    type: "session", version: 3, id: `${id}-side`, timestamp: "2026-08-14T00:00:00.000Z", cwd: dir,
  })}\n${JSON.stringify({
    type: "message", id: "root", parentId: null, timestamp: "2026-08-14T00:00:01.000Z",
    message: { role: "user", content: "root" },
  })}\n${JSON.stringify({
    type: "message", id: "side", parentId: "root", timestamp: "2026-08-14T00:00:02.000Z",
    message: { role: "user", content: "side branch" },
  })}\n${JSON.stringify({
    type: "message", id: "main", parentId: "root", timestamp: "2026-08-14T00:00:03.000Z",
    message: { role: "user", content: "main branch" },
  })}\n`);
  cacheSessionPath(`${id}-side`, sidePath);
  const branched = await (await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}-side?limit=10&leafId=side`),
    { params: Promise.resolve({ id: `${id}-side` }) },
  )).json();
  assert.deepEqual(branched.context.messages.map((message) => message.content), ["root", "side branch"]);
});

test("transcript mode exposes pre-compaction messages while default context stays compacted", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const dir = mkdtempSync(join(tmpdir(), "pi-web-transcript-route-"));
  const id = "transcript-route-test";
  const path = join(dir, `${id}.jsonl`);
  const entries = [
    { type: "session", version: 3, id, timestamp: "2026-08-14T00:00:00.000Z", cwd: dir },
    { type: "message", id: "u1", parentId: null, timestamp: "2026-08-14T00:00:01.000Z", message: { role: "user", content: "old" } },
    { type: "message", id: "u2", parentId: "u1", timestamp: "2026-08-14T00:00:02.000Z", message: { role: "user", content: "kept" } },
    { type: "compaction", id: "cmp", parentId: "u2", timestamp: "2026-08-14T00:00:03.000Z", summary: "summary", firstKeptEntryId: "u2", tokensBefore: 20 },
    { type: "message", id: "u3", parentId: "cmp", timestamp: "2026-08-14T00:00:04.000Z", message: { role: "user", content: "new" } },
  ];
  writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  cacheSessionPath(id, path);
  globalThis.__piSessions = new Map();
  t.after(() => { globalThis.__piSessions = previousRegistry; });

  const routeContext = { params: Promise.resolve({ id }) };
  const context = await (await getSessionDetail(new Request(`http://localhost/api/sessions/${id}?limit=10`), routeContext)).json();
  const transcript = await (await getSessionContext(new Request(`http://localhost/api/sessions/${id}/context?history=transcript&limit=10`), routeContext)).json();
  assert.deepEqual(context.context.entryIds, ["cmp", "u2", "u3"]);
  assert.deepEqual(transcript.context.entryIds, ["u1", "u2", "cmp", "u3"]);
});
