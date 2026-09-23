import { stat } from "fs/promises";
import { join, resolve } from "path";
import { CONFIG_DIR_NAME, createAgentSessionServices, getAgentDir, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { initialThinkingLevelForModel } from "@/lib/model-initial-thinking";
import {
  loadModelsWithCache,
  withModelRuntimeError,
  withSafeModelLoadFailure,
  type ModelsData,
} from "@/lib/models-cache";
import { resolveVisibleModels, selectInitialModelScope } from "@/lib/model-scope";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { projectTrustReloadOptions } from "@/lib/project-trust";


const modelNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

async function settingsFileRevision(path: string): Promise<string> {
  try {
    const file = await stat(path);
    return `${file.dev}:${file.ino}:${file.size}:${file.mtimeMs}:${file.ctimeMs}`;
  } catch (error) {
    // SettingsManager handles unreadable files. Skip caching this response so
    // permissions changing later cannot leave a stale preview or hide models.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    return "error";
  }
}

async function modelConfigurationRevision(cwd: string): Promise<string> {
  const agentDir = getAgentDir();
  const revisions = await Promise.all([
    settingsFileRevision(join(agentDir, "settings.json")),
    settingsFileRevision(join(cwd, CONFIG_DIR_NAME, "settings.json")),
    settingsFileRevision(join(agentDir, "trust.json")),
  ]);
  return revisions.join("|");
}

function compareModelEntries(
  a: { id: string; name: string; provider: string },
  b: { id: string; name: string; provider: string }
): number {
  return modelNameCollator.compare(a.name || a.id, b.name || b.id)
    || modelNameCollator.compare(a.provider, b.provider)
    || modelNameCollator.compare(a.id, b.id);
}

async function loadModels(cwd: string): Promise<ModelsData> {
  const nameMap = new Map<string, string>();
  let modelList: { id: string; name: string; provider: string }[] = [];
  let defaultModel: { provider: string; modelId: string } | null = null;
  const thinkingLevels: Record<string, string[]> = {};
  const thinkingLevelMaps: Record<string, Record<string, string | null>> = {};
  const initialThinkingLevels: Record<string, string> = {};

  const agentDir = getAgentDir();
  // Gate untrusted project extensions: enumerating models still imports and
  // runs a repository's .pi/extensions factories, so honor project trust here
  // too (see lib/project-trust.ts, #236).
  const trustReloadOptions = projectTrustReloadOptions(cwd, agentDir);
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    ...(trustReloadOptions ? { resourceLoaderReloadOptions: trustReloadOptions } : {}),
  });
  const modelError = services.modelRuntime.getError();
  const settings: SettingsManager = services.settingsManager;
  // `enabledModels` supports globs and fuzzy patterns, so resolve it the same
  // way the CLI does instead of comparing pattern strings literally (#307).
  const scope = await resolveVisibleModels(
    services.modelRuntime,
    settings.getEnabledModels(),
  );
  const { visible, thinkingLevelPins, warnings } = scope;
  modelList = visible.map((m) => ({
    id: m.id,
    name: m.name,
    provider: m.provider,
  })).sort(compareModelEntries);
  for (const m of visible) {
    const key = `${m.provider}:${m.id}`;
    nameMap.set(key, m.name);
    thinkingLevels[key] = getSupportedThinkingLevels(m);
    // Match the SDK's startup precedence without writing the global setting.
    initialThinkingLevels[`${m.provider}/${m.id}`] = initialThinkingLevelForModel(
      m,
      thinkingLevelPins[`${m.provider}/${m.id}`] as ThinkingLevel | undefined,
      settings.getModelThinkingLevel(m.provider, m.id),
      settings.getDefaultThinkingLevel(),
    );
    if (m.thinkingLevelMap) thinkingLevelMaps[key] = m.thinkingLevelMap;
  }

  const defaultProvider = settings.getDefaultProvider();
  const defaultModelId = settings.getDefaultModel();
  const initial = selectInitialModelScope(scope, {
    ...(defaultProvider && defaultModelId
      ? { defaultModel: { provider: defaultProvider, modelId: defaultModelId } }
      : {}),
  });
  if (initial.model) {
    defaultModel = { provider: initial.model.provider, modelId: initial.model.id };
  }

  return withModelRuntimeError(
    {
      models: Object.fromEntries(nameMap),
      modelList,
      defaultModel,
      thinkingLevels,
      thinkingLevelMaps,
      thinkingLevelPins,
      initialThinkingLevels,
      ...(warnings.length > 0 ? { modelScopeWarnings: warnings } : {}),
    },
    modelError,
  );
}

const EMPTY_MODELS: ModelsData = {
  models: {},
  modelList: [],
  defaultModel: null,
  thinkingLevels: {},
  thinkingLevelMaps: {},
  thinkingLevelPins: {},
  initialThinkingLevels: {},
};

export async function GET(req: Request) {
  const requestedCwd = new URL(req.url).searchParams.get("cwd") || process.cwd();
  const cwd = resolve(requestedCwd);

  let cwdStat;
  try {
    cwdStat = await stat(cwd);
  } catch {
    return Response.json({ error: `Directory does not exist: ${cwd}` }, { status: 400 });
  }
  if (!cwdStat.isDirectory()) {
    return Response.json({ error: `Not a directory: ${cwd}` }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(cwd, allowedRoots)) {
    return Response.json({ error: "Access denied" }, { status: 403 });
  }

  try {
    // External settings edits change the cache key so the preview reads the
    // same defaults a newly constructed SDK session will read.
    const revision = await modelConfigurationRevision(cwd);
    const data = revision.split("|").includes("error")
      ? await loadModels(cwd)
      : await loadModelsWithCache(`${cwd}\0${revision}`, () => loadModels(cwd));
    return Response.json(data);
  } catch {
    return Response.json(withSafeModelLoadFailure(EMPTY_MODELS));
  }
}
