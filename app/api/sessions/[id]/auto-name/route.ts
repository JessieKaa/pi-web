import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  generateSessionTitle,
  resolveSessionTitleOverride,
  type SessionTitleModelOverride,
} from "@/lib/session-title";
import { readTitleGenerationPreference } from "@/lib/title-generation-settings";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";

interface TitleGenerationMetadata {
  usedConfiguredPreference: boolean;
  fallbackReason?: string;
}

interface ResolvedTitleGenerationOverride {
  override?: SessionTitleModelOverride;
  titleGeneration: TitleGenerationMetadata;
}

/**
 * Resolve the optional title-generation model/thinking preference against the
 * live session runtime. Settings are best-effort: a missing, stale, out-of-scope,
 * unsupported, or unreadable preference falls back to the session's own model
 * and thinking level without mutating the session or its JSONL.
 */
async function resolveTitleGenerationOverride(
  session: AgentSession,
): Promise<ResolvedTitleGenerationOverride> {
  try {
    const preference = readTitleGenerationPreference();
    const resolution = await resolveSessionTitleOverride(
      preference,
      session.modelRuntime,
      session.settingsManager.getEnabledModels(),
    );
    return {
      ...(resolution.override ? { override: resolution.override } : {}),
      titleGeneration: {
        usedConfiguredPreference: resolution.usedConfiguredPreference,
        ...(resolution.fallbackReason ? { fallbackReason: resolution.fallbackReason } : {}),
      },
    };
  } catch {
    return {
      titleGeneration: { usedConfiguredPreference: false, fallbackReason: "resolution-failed" },
    };
  }
}

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    const existing = getRpcSession(id);
    const { session } = existing?.isAlive()
      ? { session: existing }
      : await startRpcSession(id, filePath, undefined);

    // globalThis keeps wrappers alive across dev hot reloads; older instances
    // may predate waitUntilReady(), but those have already completed startup.
    await session.waitUntilReady?.();
    const agentSession = session.inner as unknown as AgentSession;
    const { override, titleGeneration } = await resolveTitleGenerationOverride(agentSession);
    const result = await generateSessionTitle(agentSession, override);

    if (!session.isAlive()) {
      return Response.json(
        { error: "The session was closed while its title was being generated. Please try again." },
        { status: 409 },
      );
    }

    session.inner.setSessionName(result.title);
    invalidateSessionListCache();
    return Response.json({
      title: result.title,
      usage: result.usage ?? null,
      titleGeneration,
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
