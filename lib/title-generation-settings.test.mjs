import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import lockfile from "proper-lockfile";

const {
  assertTitleGenerationPreference,
  readTitleGenerationPreference,
  updateTitleGenerationPreference,
} = await createJiti(import.meta.url).import("./title-generation-settings.ts");

function createTempSettings(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-title-generation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const settingsPath = join(root, "agent", "settings.json");
  mkdirSync(join(root, "agent"), { recursive: true });
  return settingsPath;
}

const preference = {
  version: 1,
  provider: "anthropic",
  modelId: "claude-sonnet-4-6",
  thinkingLevel: "medium",
};

test("reads null when the settings file or preference is absent", async (t) => {
  const settingsPath = createTempSettings(t);
  assert.equal(await readTitleGenerationPreference(settingsPath), null);

  writeFileSync(settingsPath, JSON.stringify({ theme: "dark", piWeb: { unrelated: true } }));
  assert.equal(await readTitleGenerationPreference(settingsPath), null);
});

test("writes the preference into the existing settings.json with private permissions", async (t) => {
  const settingsPath = createTempSettings(t);
  writeFileSync(settingsPath, JSON.stringify({ theme: "dark", defaultTools: ["read"] }));

  const saved = await updateTitleGenerationPreference(preference, settingsPath);
  assert.deepEqual(saved, preference);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    theme: "dark",
    defaultTools: ["read"],
    piWeb: { titleGeneration: preference },
  });
  assert.deepEqual(await readTitleGenerationPreference(settingsPath), preference);
  if (process.platform !== "win32") {
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  }
});

test("creates settings.json when missing", async (t) => {
  const settingsPath = createTempSettings(t);
  await updateTitleGenerationPreference(preference, settingsPath);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    piWeb: { titleGeneration: preference },
  });
  if (process.platform !== "win32") {
    assert.equal(statSync(settingsPath).mode & 0o777, 0o600);
  }
});

test("preserves unrelated piWeb keys", async (t) => {
  const settingsPath = createTempSettings(t);
  writeFileSync(settingsPath, JSON.stringify({ piWeb: { somethingElse: { keep: 1 } } }));

  await updateTitleGenerationPreference(preference, settingsPath);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    piWeb: { somethingElse: { keep: 1 }, titleGeneration: preference },
  });
});

test("clearing removes only piWeb.titleGeneration", async (t) => {
  const settingsPath = createTempSettings(t);
  writeFileSync(settingsPath, JSON.stringify({
    theme: "dark",
    piWeb: { somethingElse: { keep: 1 }, titleGeneration: preference },
  }));

  assert.equal(await updateTitleGenerationPreference(null, settingsPath), null);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    theme: "dark",
    piWeb: { somethingElse: { keep: 1 } },
  });

  // Clearing the last piWeb key drops the empty namespace, but does not create one.
  writeFileSync(settingsPath, JSON.stringify({ theme: "dark", piWeb: { titleGeneration: preference } }));
  await updateTitleGenerationPreference(null, settingsPath);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { theme: "dark" });

  writeFileSync(settingsPath, "{}");
  await updateTitleGenerationPreference(null, settingsPath);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {});
});

test("fails closed on malformed root JSON or a non-object piWeb namespace", async (t) => {
  const settingsPath = createTempSettings(t);
  const malformed = "{ not json";
  writeFileSync(settingsPath, malformed);

  await assert.rejects(
    updateTitleGenerationPreference(preference, settingsPath),
    /JSON/,
  );
  assert.equal(readFileSync(settingsPath, "utf8"), malformed);

  writeFileSync(settingsPath, JSON.stringify({ piWeb: "nope", theme: "dark" }));
  await assert.rejects(
    updateTitleGenerationPreference(preference, settingsPath),
    /piWeb must be an object/,
  );
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { piWeb: "nope", theme: "dark" });
});

test("a malformed stored preference reads as absent instead of throwing", async (t) => {
  const settingsPath = createTempSettings(t);
  writeFileSync(settingsPath, JSON.stringify({
    piWeb: { titleGeneration: { version: 2, provider: "x", modelId: "y", thinkingLevel: "medium" } },
  }));
  assert.equal(await readTitleGenerationPreference(settingsPath), null);
});

test("changing the preference under an external lock preserves concurrent settings", async (t) => {
  const settingsPath = createTempSettings(t);
  writeFileSync(settingsPath, JSON.stringify({ theme: "dark" }));

  const release = await lockfile.lock(settingsPath, { realpath: false, stale: 30_000 });
  const update = updateTitleGenerationPreference(preference, settingsPath);
  writeFileSync(settingsPath, JSON.stringify({
    theme: "light",
    unrelatedPiWeb: true,
    piWeb: { concurrent: true },
  }));
  await release();

  assert.deepEqual(await update, preference);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), {
    theme: "light",
    unrelatedPiWeb: true,
    piWeb: { concurrent: true, titleGeneration: preference },
  });
});

test("rejects preferences that do not match the schema", () => {
  assert.equal(assertTitleGenerationPreference(null), null);
  assert.deepEqual(assertTitleGenerationPreference(preference), preference);

  for (const invalid of [
    undefined,
    "anthropic",
    { version: 2, provider: "a", modelId: "b", thinkingLevel: "off" },
    { version: 1, provider: 7, modelId: "b", thinkingLevel: "off" },
    { version: 1, provider: "a", modelId: null, thinkingLevel: "off" },
    { version: 1, provider: "a", modelId: "b", thinkingLevel: "ultra" },
  ]) {
    assert.throws(() => assertTitleGenerationPreference(invalid), undefined, JSON.stringify(invalid));
  }
});
