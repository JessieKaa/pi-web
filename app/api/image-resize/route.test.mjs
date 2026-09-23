import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const route = await jiti.import("./route.ts");

const HOST_HEADERS = { Host: "localhost:30141", Origin: "http://localhost:30141" };

const jsonRequest = (method, body) => new Request("http://localhost/api/image-resize", {
  method,
  headers: { ...HOST_HEADERS, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

test("PUT rejects a non-boolean enabled flag", async () => {
  const response = await route.PUT(jsonRequest("PUT", { enabled: "yes" }));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /enabled must be a boolean/);
});

test("PUT rejects non-JSON bodies", async () => {
  const response = await route.PUT(new Request("http://localhost/api/image-resize", {
    method: "PUT",
    headers: HOST_HEADERS,
    body: "enabled=true",
  }));
  assert.equal(response.status, 415);
});

test("GET rejects cross-site browser requests", async () => {
  const response = await route.GET(new Request("http://localhost/api/image-resize", {
    headers: { ...HOST_HEADERS, "Sec-Fetch-Site": "cross-site" },
  }));
  assert.equal(response.status, 403);
});

test("the global switch ignores a live session's project override and reloads only idle sessions", async () => {
  const calls = [];
  globalThis.__piSessions = new Map([
    ["project", {
      isAlive: () => true,
      isRunning: () => false,
      sessionId: "project",
      inner: {
        settingsManager: {
          getImageAutoResize: () => false,
          getGlobalSettings: () => ({ images: { autoResize: true } }),
          setImageAutoResize: (enabled) => calls.push(`set:${enabled}`),
        },
        reload: () => {
          calls.push("reload:project");
          return Promise.resolve();
        },
      },
    }],
    ["busy", {
      isAlive: () => true,
      isRunning: () => true,
      sessionId: "busy",
      inner: {
        settingsManager: { setImageAutoResize: (enabled) => calls.push(`busy:${enabled}`) },
        reload: () => {
          calls.push("reload:busy");
          return Promise.resolve();
        },
      },
    }],
    ["dead", {
      isAlive: () => false,
      isRunning: () => false,
      sessionId: "dead",
      inner: {
        settingsManager: { setImageAutoResize: () => calls.push("dead") },
        reload: () => calls.push("reload:dead"),
      },
    }],
  ]);
  try {
    const { applyRpcImageAutoResize, getRpcImageAutoResize } = await jiti.import("@/lib/rpc-manager.ts");
    assert.equal(getRpcImageAutoResize("/other"), true);
    assert.equal(await applyRpcImageAutoResize(false), 2);
    assert.deepEqual(calls, ["set:false", "reload:project", "busy:false"]);
  } finally {
    delete globalThis.__piSessions;
  }
});
