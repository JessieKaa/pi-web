import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });

/** The route is inside the app's module graph, so load it the same way pi-web tests do. */
const route = await jiti.import("./route.ts");

const HOST_HEADERS = { Host: "localhost:30141", Origin: "http://localhost:30141" };

const jsonRequest = (method, body) => new Request("http://localhost/api/cache-warming", {
  method,
  headers: { ...HOST_HEADERS, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

test("PUT rejects modes outside pi's cache-warming profiles", async () => {
  const response = await route.PUT(jsonRequest("PUT", { mode: "aggressive" }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /mode must be one of off, streaming, idle/);
});

test("PUT rejects non-JSON bodies", async () => {
  const response = await route.PUT(new Request("http://localhost/api/cache-warming", {
    method: "PUT",
    headers: HOST_HEADERS,
    body: "mode=idle",
  }));
  assert.equal(response.status, 415);
});

test("GET rejects cross-site browser requests", async () => {
  const response = await route.GET(new Request("http://localhost/api/cache-warming", {
    headers: { ...HOST_HEADERS, "Sec-Fetch-Site": "cross-site" },
  }));
  assert.equal(response.status, 403);
});

test("applyRpcCacheWarmingMode pushes the mode into every live session", async () => {
  const applied = [];
  globalThis.__piSessions = new Map([
    [
      "live",
      {
        isAlive: () => true,
        inner: {
          setCacheWarmingMode: (mode) => applied.push(mode),
          settingsManager: { getCacheWarmingMode: () => "streaming" },
        },
      },
    ],
    ["dead", { isAlive: () => false, inner: { setCacheWarmingMode: (mode) => applied.push(`dead:${mode}`) } }],
  ]);
  try {
    const { applyRpcCacheWarmingMode, getRpcCacheWarmingMode } = await jiti.import("@/lib/rpc-manager.ts");
    assert.equal(applyRpcCacheWarmingMode("idle"), 1);
    assert.deepEqual(applied, ["idle"]);
    assert.equal(getRpcCacheWarmingMode(), "streaming", "reads the live session's committed mode");
  } finally {
    delete globalThis.__piSessions;
  }
});
