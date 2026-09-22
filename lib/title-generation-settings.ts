import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { THINKING_LEVEL_RANK, type RankedThinkingLevel } from "./thinking-level";

const SETTINGS_VERSION = 1;
const PI_WEB_KEY = "piWeb";
const TITLE_GENERATION_KEY = "titleGeneration";

/**
 * Title-generation preference persisted inside `~/.pi/agent/settings.json`
 * under `piWeb.titleGeneration`. Runtime model availability is intentionally
 * not validated here: the caller decides whether a stored selection is usable.
 */
export interface TitleGenerationPreference {
  version: typeof SETTINGS_VERSION;
  provider: string;
  modelId: string;
  thinkingLevel: RankedThinkingLevel;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getTitleGenerationSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "settings.json");
}

/**
 * Strictly validate a preference supplied by an API caller. `null` clears the
 * stored preference; anything else that does not match the schema throws.
 */
export function assertTitleGenerationPreference(
  value: unknown,
): TitleGenerationPreference | null {
  if (value === null) return null;
  if (!isRecord(value) || value.version !== SETTINGS_VERSION) {
    throw new Error(
      "preference must be null or { version: 1, provider, modelId, thinkingLevel }",
    );
  }
  if (typeof value.provider !== "string") {
    throw new Error("preference.provider must be a string");
  }
  if (typeof value.modelId !== "string") {
    throw new Error("preference.modelId must be a string");
  }
  if (!THINKING_LEVEL_RANK.includes(value.thinkingLevel as RankedThinkingLevel)) {
    throw new Error(
      `preference.thinkingLevel must be one of ${THINKING_LEVEL_RANK.join(", ")}`,
    );
  }
  return {
    version: SETTINGS_VERSION,
    provider: value.provider,
    modelId: value.modelId,
    thinkingLevel: value.thinkingLevel as RankedThinkingLevel,
  };
}

/** Lenient read of a stored value; unknown/legacy shapes are treated as absent. */
function storedTitleGenerationPreference(
  settings: Record<string, unknown>,
): TitleGenerationPreference | null {
  const piWeb = settings[PI_WEB_KEY];
  if (!isRecord(piWeb) || !Object.hasOwn(piWeb, TITLE_GENERATION_KEY)) return null;
  const value = piWeb[TITLE_GENERATION_KEY];
  if (value === null || value === undefined) return null;
  try {
    return assertTitleGenerationPreference(value);
  } catch {
    return null;
  }
}

function ensureSettingsFile(settingsPath: string): void {
  const parent = dirname(settingsPath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o700 });
  if (existsSync(settingsPath)) return;
  try {
    writeFileSync(settingsPath, "{}", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  chmodSync(settingsPath, 0o600);
}

function parseSettings(settingsPath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
  if (!isRecord(parsed)) throw new Error("Invalid settings.json: expected an object");
  return parsed;
}

/**
 * Read-modify-write `settings.json` under its proper-lockfile lock so a
 * concurrent pi/pi-web writer cannot clobber unrelated settings. The update
 * callback mutates the parsed root object and reports whether to persist it.
 */
async function updateLockedSettings<T>(
  settingsPath: string,
  update: (settings: Record<string, unknown>) => { result: T; changed: boolean },
  createIfMissing: boolean,
): Promise<T> {
  if (createIfMissing) ensureSettingsFile(settingsPath);

  let lockCompromisedError: Error | undefined;
  const release = await lockfile.lock(settingsPath, {
    realpath: false,
    retries: {
      retries: 10,
      factor: 2,
      minTimeout: 100,
      maxTimeout: 10_000,
      randomize: true,
    },
    stale: 30_000,
    onCompromised: (error) => {
      lockCompromisedError = error;
    },
  });

  const throwIfCompromised = () => {
    if (lockCompromisedError) throw lockCompromisedError;
  };

  try {
    throwIfCompromised();
    const settings = parseSettings(settingsPath);
    const { result, changed } = update(settings);
    if (changed) {
      throwIfCompromised();
      writePrivateFileAtomicSync(settingsPath, JSON.stringify(settings, null, 2));
      throwIfCompromised();
    }
    return result;
  } finally {
    try {
      await release();
    } catch {
      // The compromised-lock error above is more useful than an unlock error.
    }
  }
}

function piWebNamespace(settings: Record<string, unknown>): Record<string, unknown> {
  const piWeb = settings[PI_WEB_KEY];
  if (piWeb === undefined) return {};
  if (!isRecord(piWeb)) throw new Error("Invalid settings.json: piWeb must be an object");
  return { ...piWeb };
}

export async function readTitleGenerationPreference(
  settingsPath = getTitleGenerationSettingsPath(),
): Promise<TitleGenerationPreference | null> {
  if (!existsSync(settingsPath)) return null;
  return updateLockedSettings(
    settingsPath,
    (settings) => ({ result: storedTitleGenerationPreference(settings), changed: false }),
    false,
  );
}

/**
 * Store or clear only `piWeb.titleGeneration`, preserving every unrelated Pi
 * setting and every other `piWeb` key. Passing `null` removes the preference
 * without creating an empty `piWeb` object.
 */
export async function updateTitleGenerationPreference(
  preference: TitleGenerationPreference | null,
  settingsPath = getTitleGenerationSettingsPath(),
): Promise<TitleGenerationPreference | null> {
  const next = assertTitleGenerationPreference(preference);
  return updateLockedSettings(settingsPath, (settings) => {
    const piWeb = piWebNamespace(settings);

    if (next === null) {
      if (!Object.hasOwn(piWeb, TITLE_GENERATION_KEY)) {
        return { result: null, changed: false };
      }
      delete piWeb[TITLE_GENERATION_KEY];
    } else {
      piWeb[TITLE_GENERATION_KEY] = next;
    }

    if (Object.keys(piWeb).length === 0) delete settings[PI_WEB_KEY];
    else settings[PI_WEB_KEY] = piWeb;
    return { result: next, changed: true };
  }, true);
}
