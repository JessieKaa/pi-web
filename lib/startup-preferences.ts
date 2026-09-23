import type { SettingsManager } from "@earendil-works/pi-coding-agent";

export interface ExplicitStartupPreferences {
  model?: { provider: string; modelId: string };
}

export interface EffectiveStartupPreferences {
  model?: { provider: string; modelId: string };
}

/**
 * Persist an explicitly selected model without re-running AgentSession setters.
 * Thinking levels remain session-local; the SDK reads the global default when
 * a session starts without an explicit level.
 */
export async function persistExplicitStartupPreferences(
  settingsManager: SettingsManager,
  explicit: ExplicitStartupPreferences,
  effective: EffectiveStartupPreferences,
): Promise<{ modelDefaultChanged: boolean }> {
  if (
    explicit.model
    && effective.model
    && explicit.model.provider === effective.model.provider
    && explicit.model.modelId === effective.model.modelId
  ) {
    settingsManager.setDefaultModelAndProvider(
      effective.model.provider,
      effective.model.modelId,
    );
    await settingsManager.flush();
    return { modelDefaultChanged: true };
  }

  return { modelDefaultChanged: false };
}
