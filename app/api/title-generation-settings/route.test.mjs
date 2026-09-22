import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";

const agentDir = mkdtempSync(join(tmpdir(), "pi-web-title-generation-route-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_WEB_PASSWORD;
delete process.env.PI_WEB_ALLOWED_HOSTS;
delete process.env.PI_WEB_HOSTNAME;
after(() => rmSync(agentDir, { recursive: true, force: true }));

const settingsPath = join(agentDir, "settings.json");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });

const preference = {
  version: 1,
  provider: "anthropic",
  modelId: "claude-sonnet-4-6",
  thinkingLevel: "high",
};

function request(method, { body, headers = {}, raw } = {}) {
  return new Request("http://127.0.0.1:30141/api/title-generation-settings", {
    method,
    headers: {
      host: "127.0.0.1:30141",
      origin: "http://127.0.0.1:30141",
      "sec-fetch-site": "same-origin",
      ...(body !== undefined || raw !== undefined ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    body: raw !== undefined ? raw : (body !== undefined ? JSON.stringify(body) : undefined),
  });
}

test("GET returns null before any preference is saved", async () => {
  const { GET } = await jiti.import("./route.ts");
  rmSync(settingsPath, { force: true });
  const response = await GET(request("GET"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { preference: null });
});

test("PUT saves and clears the preference inside settings.json", async () => {
  const { GET, PUT } = await jiti.import("./route.ts");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ theme: "dark", piWeb: { keep: true } }));

  const saved = await PUT(request("PUT", { body: { preference } }));
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { preference });
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    theme: "dark",
    piWeb: { keep: true, titleGeneration: preference },
  });

  const get = await GET(request("GET"));
  assert.deepEqual(await get.json(), { preference });

  const cleared = await PUT(request("PUT", { body: { preference: null } }));
  assert.equal(cleared.status, 200);
  assert.deepEqual(await cleared.json(), { preference: null });
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    theme: "dark",
    piWeb: { keep: true },
  });
});

test("PUT rejects invalid preferences and writes nothing", async () => {
  const { PUT } = await jiti.import("./route.ts");
  writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

  for (const invalid of [
    {},
    { preference: undefined },
    { preference: { version: 2, provider: "a", modelId: "b", thinkingLevel: "off" } },
    { preference: { version: 1, provider: 1, modelId: "b", thinkingLevel: "off" } },
    { preference: { version: 1, provider: "a", modelId: "b", thinkingLevel: "ultra" } },
  ]) {
    const response = await PUT(request("PUT", { body: invalid }));
    assert.equal(response.status, 400, JSON.stringify(invalid));
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { theme: "dark" });
  }
});

test("PUT rejects non-object and malformed JSON bodies", async () => {
  const { PUT } = await jiti.import("./route.ts");
  for (const raw of ["null", "5", '"yes"', "[]", "{"]) {
    const response = await PUT(request("PUT", { raw }));
    assert.equal(response.status, 400, raw);
  }
});

test("PUT requires a JSON content type", async () => {
  const { PUT } = await jiti.import("./route.ts");
  const response = await PUT(new Request("http://127.0.0.1:30141/api/title-generation-settings", {
    method: "PUT",
    headers: {
      host: "127.0.0.1:30141",
      origin: "http://127.0.0.1:30141",
      "sec-fetch-site": "same-origin",
      "content-type": "text/plain",
    },
    body: "preference=null",
  }));
  assert.equal(response.status, 415);
});

test("GET and PUT reject untrusted and cross-site requests", async () => {
  const { GET, PUT } = await jiti.import("./route.ts");
  assert.equal(
    (await GET(request("GET", { headers: { host: "evil.example.com" } }))).status,
    403,
  );
  assert.equal(
    (await PUT(request("PUT", { body: { preference }, headers: { "sec-fetch-site": "cross-site" } }))).status,
    403,
  );
});

test("GET fails closed when settings.json is malformed", async () => {
  const { GET } = await jiti.import("./route.ts");
  writeFileSync(settingsPath, "{ not json");
  const response = await GET(request("GET"));
  assert.equal(response.status, 500);
});
