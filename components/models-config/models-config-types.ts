// Shared types for the Models settings surface. These shapes mirror the
// models.json document and the auth provider listings; do not broaden them
// or change serialized fields.

export interface OAuthProvider {
  id: string;
  name: string;
  usesCallbackServer: boolean;
  loggedIn: boolean;
  /** Provider also accepts an API key, so it appears in both picker sections. */
  supportsApiKey?: boolean;
}

export interface ApiKeyProvider {
  id: string;
  displayName: string;
  configured: boolean;
  source?: string;
  modelCount: number;
  /** Provider also supports OAuth, so it appears in both picker sections. */
  supportsOAuth?: boolean;
}

export interface ModelImageResize {
  maxWidth?: number;
  maxHeight?: number;
  maxBytes?: number;
  jpegQuality?: number;
}

export interface ModelEntry {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input?: string[];
  inputLimits?: {
    maxRequestBytes?: number;
    images?: {
      resize?: ModelImageResize;
      maxPerMessage?: number;
      maxPerRequest?: number;
    };
  };
  contextWindow?: number;
  maxTokens?: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; tiers?: unknown };
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

const IMAGE_RESIZE_KEYS = ["maxWidth", "maxHeight", "maxBytes", "jpegQuality"] as const;
export type ImageResizeKey = (typeof IMAGE_RESIZE_KEYS)[number];

/** Set one cache-safe resize field. Blank or invalid input drops that field and empty parents. */
export function withImageResize(model: ModelEntry, key: ImageResizeKey, raw: string): ModelEntry {
  const resize: ModelImageResize = { ...(model.inputLimits?.images?.resize ?? {}) };
  if (!raw.trim()) delete resize[key];
  else {
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0) return model;
    resize[key] = value;
  }
  const images = { ...(model.inputLimits?.images ?? {}) };
  if (Object.keys(resize).length) images.resize = resize;
  else delete images.resize;
  const inputLimits = { ...(model.inputLimits ?? {}) };
  if (Object.keys(images).length) inputLimits.images = images;
  else delete inputLimits.images;
  return { ...model, inputLimits: Object.keys(inputLimits).length ? inputLimits : undefined };
}

export interface ProviderEntry {
  baseUrl?: string;
  api?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ModelEntry[];
  modelOverrides?: Record<string, unknown>;
}

export interface ModelsJson {
  providers?: Record<string, ProviderEntry>;
}

export type Selection =
  | { type: "provider"; name: string }
  | { type: "model"; providerName: string; index: number }
  | { type: "oauth"; providerId: string }
  | { type: "apikey"; providerId: string };

/** Row shown under the Accounts group in the models navigator. */
export interface ModelsAccountItem {
  kind: "oauth" | "apikey";
  id: string;
  name: string;
  connected: boolean;
  modelCount: number;
}

/** Row shown under the Custom providers group, with its model rows. */
export interface ModelsCustomProviderItem {
  name: string;
  baseUrl?: string;
  api?: string;
  modelCount: number;
  models: { id: string; name?: string; reasoning?: boolean; index: number }[];
}

/**
 * Settings integration contract. ModelsConfig reports this controller to
 * SettingsPage; SettingsPage combines it with its dirty-exit dialog and
 * registers one back handler with AppShell.
 */
export interface ModelsDraftController {
  dirty: boolean;
  discard(): void;
  /** Consumes Models-owned back layers (picker, confirmation, detail). */
  handleBack(): boolean;
  mobileDetailOpen: boolean;
}
