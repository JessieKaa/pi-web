/**
 * Pure selection helpers for the session-title-generation settings section.
 * The API contract is `{ preference: { version: 1, provider, modelId, thinkingLevel } | null }`;
 * these helpers keep the dependent Provider → Model → Thinking-level control logic
 * out of the component so it can be unit tested without a DOM.
 */

export interface TitleGenerationPreference {
  version: 1;
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

export interface TitleGenerationSelection {
  provider: string;
  modelId: string;
  thinkingLevel: string;
}

export interface TitleModelOption {
  id: string;
  name: string;
  provider: string;
}

/** The subset of `GET /api/models?cwd=...` the title settings need. */
export interface TitleGenerationModels {
  modelList: TitleModelOption[];
  defaultModel: { provider: string; modelId: string } | null;
  thinkingLevels: Record<string, string[]>;
  thinkingLevelMaps: Record<string, Record<string, string | null>>;
}

export interface TitleSelectOption {
  value: string;
  label: string;
  /** Set for a stored value that is not part of the current scope; shown but not choosable. */
  disabled?: boolean;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function titleModelKey(provider: string, modelId: string): string {
  return `${provider}:${modelId}`;
}

export function normalizeTitlePreference(value: unknown): TitleGenerationPreference | null {
  if (!value || typeof value !== "object") return null;
  const preference = value as Partial<TitleGenerationPreference>;
  if (
    preference.version !== 1
    || typeof preference.provider !== "string"
    || typeof preference.modelId !== "string"
    || typeof preference.thinkingLevel !== "string"
    || !preference.provider
    || !preference.modelId
    || !preference.thinkingLevel
  ) {
    return null;
  }
  return {
    version: 1,
    provider: preference.provider,
    modelId: preference.modelId,
    thinkingLevel: preference.thinkingLevel,
  };
}

export function selectionFromPreference(preference: TitleGenerationPreference): TitleGenerationSelection {
  return {
    provider: preference.provider,
    modelId: preference.modelId,
    thinkingLevel: preference.thinkingLevel,
  };
}

export function preferenceFromSelection(selection: TitleGenerationSelection): TitleGenerationPreference {
  return { version: 1, ...selection };
}

export function isTitleModelAvailable(models: TitleGenerationModels, provider: string, modelId: string): boolean {
  return models.modelList.some((model) => model.provider === provider && model.id === modelId);
}

/**
 * Levels the model can actually use. `thinkingLevels` already drops null-mapped
 * levels, but we filter through `thinkingLevelMaps` too so a stale payload can
 * never surface an invalid level in the selector.
 */
export function titleThinkingLevelsFor(
  models: TitleGenerationModels,
  provider: string,
  modelId: string,
): string[] {
  const key = titleModelKey(provider, modelId);
  const levels = models.thinkingLevels[key] ?? [];
  const levelMap = models.thinkingLevelMaps[key] ?? {};
  return levels.filter((level) => levelMap[level] !== null);
}

export function buildTitleProviderOptions(
  models: TitleGenerationModels,
  currentProvider: string | null,
): TitleSelectOption[] {
  const derived = [...new Set(models.modelList.map((model) => model.provider))].sort(collator.compare);
  const options: TitleSelectOption[] = derived.map((provider) => ({ value: provider, label: provider }));
  if (currentProvider && !derived.includes(currentProvider)) {
    options.unshift({ value: currentProvider, label: currentProvider, disabled: true });
  }
  return options;
}

export function buildTitleModelOptions(
  models: TitleGenerationModels,
  provider: string,
  currentModelId: string | null,
): TitleSelectOption[] {
  const derived = models.modelList
    .filter((model) => model.provider === provider)
    .sort((a, b) => collator.compare(a.name || a.id, b.name || b.id) || collator.compare(a.id, b.id));
  const options: TitleSelectOption[] = derived.map((model) => ({ value: model.id, label: model.name || model.id }));
  if (currentModelId && !derived.some((model) => model.id === currentModelId)) {
    options.unshift({ value: currentModelId, label: currentModelId, disabled: true });
  }
  return options;
}

export function buildTitleThinkingOptions(
  models: TitleGenerationModels,
  provider: string,
  modelId: string,
  currentLevel: string | null,
): TitleSelectOption[] {
  const derived = titleThinkingLevelsFor(models, provider, modelId);
  const options: TitleSelectOption[] = derived.map((level) => ({ value: level, label: level }));
  if (currentLevel && !derived.includes(currentLevel)) {
    options.unshift({ value: currentLevel, label: currentLevel, disabled: true });
  }
  return options;
}

export function firstTitleModelForProvider(
  models: TitleGenerationModels,
  provider: string,
): TitleModelOption | null {
  const modelsForProvider = models.modelList
    .filter((model) => model.provider === provider)
    .sort((a, b) => collator.compare(a.name || a.id, b.name || b.id) || collator.compare(a.id, b.id));
  return modelsForProvider[0] ?? null;
}

export function firstTitleThinkingLevel(
  models: TitleGenerationModels,
  provider: string,
  modelId: string,
  preferred?: string,
): string {
  const levels = titleThinkingLevelsFor(models, provider, modelId);
  if (preferred && levels.includes(preferred)) return preferred;
  return levels[0] ?? "off";
}

/** When the preference is `null`, start from the project default (or first) model. */
export function defaultTitleSelection(models: TitleGenerationModels): TitleGenerationSelection | null {
  const preferred = models.defaultModel;
  const model = (preferred
    ? models.modelList.find((entry) => entry.provider === preferred.provider && entry.id === preferred.modelId)
    : undefined) ?? models.modelList[0];
  if (!model) return null;
  return {
    provider: model.provider,
    modelId: model.id,
    thinkingLevel: firstTitleThinkingLevel(models, model.provider, model.id),
  };
}

/**
 * Build a coherent selection after the provider changes. Returns `null` when the
 * provider has no model in scope so the caller leaves the stored preference alone.
 */
export function changeTitleProvider(
  models: TitleGenerationModels,
  selection: TitleGenerationSelection,
  provider: string,
): TitleGenerationSelection | null {
  const model = firstTitleModelForProvider(models, provider);
  if (!model) return null;
  return {
    provider,
    modelId: model.id,
    thinkingLevel: firstTitleThinkingLevel(models, provider, model.id, selection.thinkingLevel),
  };
}

/** Keep the current thinking level when the new model supports it, otherwise pick the first valid one. */
export function changeTitleModel(
  models: TitleGenerationModels,
  selection: TitleGenerationSelection,
  modelId: string,
): TitleGenerationSelection {
  return {
    ...selection,
    modelId,
    thinkingLevel: firstTitleThinkingLevel(models, selection.provider, modelId, selection.thinkingLevel),
  };
}

export function changeTitleThinking(
  selection: TitleGenerationSelection,
  thinkingLevel: string,
): TitleGenerationSelection {
  return { ...selection, thinkingLevel };
}
