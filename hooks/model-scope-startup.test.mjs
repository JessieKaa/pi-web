import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");

test("new-session startup sends only explicit browser overrides", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureNewSession"),
    source.indexOf("const loadSlashCommands"),
  );

  assert.match(ensureSource, /const selectedModel = newSessionModelOverrideRef\.current;/);
  assert.doesNotMatch(ensureSource, /newSessionModel \?\? newSessionDefaultModel/);
  assert.match(ensureSource, /const selectedThinkingLevel = thinkingLevelOverrideRef\.current;/);
  assert.doesNotMatch(ensureSource, /thinkingLevel !== "auto"/);
});

test("new-session startup adopts server state only while explicit overrides are unchanged", () => {
  const ensureSource = source.slice(
    source.indexOf("const ensureNewSession"),
    source.indexOf("const loadSlashCommands"),
  );

  assert.match(
    ensureSource,
    /result\.model && newSessionModelOverrideRef\.current === selectedModel/,
  );
  assert.match(ensureSource, /setPendingModel\(result\.model\)/);
  assert.match(ensureSource, /setNewSessionDefaultModel\(result\.model\)/);
  assert.match(
    ensureSource,
    /thinkingLevelOverrideRef\.current === selectedThinkingLevel/,
  );
  assert.match(ensureSource, /setThinkingLevel\(result\.thinkingLevel\)/);
});

test("model-list refresh does not overwrite a live session or explicit thinking override", () => {
  const loadModelsSource = source.slice(
    source.indexOf("const loadModels = useCallback"),
    source.indexOf("const handleBuiltinSlashCommand"),
  );

  assert.match(loadModelsSource, /if \(isNew && !sessionIdRef\.current\)/);
  assert.match(
    loadModelsSource,
    /thinkingLevelOverrideRef\.current === null/,
  );
  assert.match(loadModelsSource, /initialThinkingLevelsRef\.current = d\.initialThinkingLevels \?\? \{\}/);
  assert.match(loadModelsSource, /const selectedModel = newSessionModelOverrideRef\.current/);
  assert.match(loadModelsSource, /setNewSessionDefaultModel\(defaultDisplayModel \?/);
  assert.match(loadModelsSource, /initialThinkingLevelsRef\.current\[`\$\{displayModel\.provider\}\/\$\{displayModel\.id\}`\]/);
  assert.doesNotMatch(loadModelsSource, /thinkingLevelOverrideRef\.current = next/);
});

test("prompting an already-created new session preserves explicit thinking and scope pins", () => {
  const promptSource = source.slice(
    source.indexOf("const handleSend"),
    source.indexOf("const handleModelChange"),
  );
  assert.match(promptSource, /if \(existingSid\) \{[\s\S]*?type: "set_model"/);
  assert.match(promptSource, /thinkingLevelOverrideRef\.current\s*\?\? \(modelThinkingLevelPinsRef\.current/);
  assert.match(promptSource, /type: "set_thinking_level", level: selectedLevel/);
});

test("selecting a model in a new session previews the read-only default", () => {
  const modelChangeSource = source.slice(
    source.indexOf("const handleModelChange"),
    source.indexOf("const handleCompact"),
  );
  assert.match(modelChangeSource, /if \(thinkingLevelOverrideRef\.current === null\)/);
  assert.match(modelChangeSource, /initialThinkingLevelsRef\.current\[`\$\{provider\}\/\$\{modelId\}`\]/);
  assert.match(modelChangeSource, /thinkingLevelOverrideRef\.current\s*\?\? \(modelThinkingLevelPinsRef\.current/);
  assert.match(modelChangeSource, /type: "set_thinking_level", level: selectedLevel/);
  assert.doesNotMatch(modelChangeSource, /applyDesiredThinkingLevel\(null/);
});
