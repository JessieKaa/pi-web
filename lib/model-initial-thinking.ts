import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

/** Preview the same startup level the SDK selects for a model, without changing settings. */
export function initialThinkingLevelForModel(
  model: Parameters<typeof clampThinkingLevel>[0],
  scopePin: ThinkingLevel | undefined,
  modelDefault: ThinkingLevel | undefined,
  globalDefault: ThinkingLevel | undefined,
): ThinkingLevel {
  // Keep this fallback in sync with the SDK's core/defaults DEFAULT_THINKING_LEVEL.
  return clampThinkingLevel(model, scopePin ?? modelDefault ?? globalDefault ?? "medium");
}
