export const THINKING_LEVEL_RANK = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type RankedThinkingLevel = (typeof THINKING_LEVEL_RANK)[number];

/**
 * Candidate sources for a session's effective thinking level, ordered from the
 * most authoritative (live runtime state) to the weakest (a static fallback).
 */
export interface SessionThinkingLevelSources {
  live?: string | null;
  persisted?: string | null;
  promoted?: string | null;
  fallback?: string | null;
}

/**
 * `""` and `"auto"` mean "no explicit choice here", so they fall through to
 * the next source. `"off"` is a real value and must be preserved.
 */
const ABSENT_THINKING_LEVEL_SIGNALS = new Set(["", "auto"]);

function presentThinkingLevel(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return ABSENT_THINKING_LEVEL_SIGNALS.has(value) ? undefined : value;
}

/**
 * Pure resolver for a session's effective thinking level. Precedence is
 * live > persisted > promoted > fallback > `"auto"`; empty strings and
 * `"auto"` are treated as absent signals, while `"off"` is a real value.
 */
export function resolveSessionThinkingLevel(sources: SessionThinkingLevelSources): string {
  return (
    presentThinkingLevel(sources.live)
    ?? presentThinkingLevel(sources.persisted)
    ?? presentThinkingLevel(sources.promoted)
    ?? presentThinkingLevel(sources.fallback)
    ?? "auto"
  );
}

export function highestThinkingLevel(
  levels: readonly string[] | null | undefined,
): RankedThinkingLevel | "auto" {
  if (!levels?.length) return "auto";
  let best: RankedThinkingLevel | undefined;
  let bestRank = -1;
  for (const level of levels) {
    const rank = THINKING_LEVEL_RANK.indexOf(level as RankedThinkingLevel);
    if (rank > bestRank) {
      bestRank = rank;
      best = level as RankedThinkingLevel;
    }
  }
  return best ?? "auto";
}

export function sessionPathHasThinkingLevelChange(
  entries: { id: string; parentId?: string | null; type: string }[],
  leafId?: string | null,
): boolean {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  let id: string | undefined = leafId ?? entries.at(-1)?.id;
  const seen = new Set<string>();
  while (id && !seen.has(id)) {
    seen.add(id);
    const entry = byId.get(id);
    if (!entry) break;
    if (entry.type === "thinking_level_change") return true;
    id = entry.parentId ?? undefined;
  }
  return false;
}
