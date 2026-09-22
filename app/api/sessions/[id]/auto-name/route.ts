import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  generateSessionTitle,
  resolveSessionTitleOverride,
  type SessionTitleGenerationMetadata,
  type SessionTitleModelOverride,
} from "@/lib/session-title";
import { readTitleGenerationPreference } from "@/lib/title-generation-settings";
import {
  getRpcSession,
  startRpcSession,
  type AgentSessionWrapper,
} from "@/lib/rpc-manager";
import { invalidateSessionListCache, resolveSessionPath } from "@/lib/session-reader";

interface ResolvedTitleGenerationOverride {
  override?: SessionTitleModelOverride;
  titleGeneration: SessionTitleGenerationMetadata;
}

/**
 * Runtime seams the auto-name handler depends on. Production passes the real
 * rpc-manager/session-reader functions; tests can drive an in-memory wrapper so
 * the persisted-preference path can be exercised without spinning up a session.
 */
export interface AutoNameRouteDeps {
  resolveSessionPath: (id: string) => Promise<string | null>;
  getRpcSession: (id: string) => AgentSessionWrapper | undefined;
  startRpcSession: (id: string, filePath: string, cwd?: string) => Promise<{ session: AgentSessionWrapper }>;
  invalidateSessionListCache: () => void;
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
    const preference = await readTitleGenerationPreference();
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

export function createAutoNamePost(deps: AutoNameRouteDeps) {
  return async function POST(
    _req: Request,
    { params }: { params: Promise<{ id: string }> },
  ) {
    const { id } = await params;

    try {
      const filePath = await deps.resolveSessionPath(id);
      if (!filePath) {
        return Response.json({ error: "Session not found" }, { status: 404 });
      }

      const existing = deps.getRpcSession(id);
      const { session } = existing?.isAlive()
        ? { session: existing }
        : await deps.startRpcSession(id, filePath);

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
      deps.invalidateSessionListCache();
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
  };
}

export const POST = createAutoNamePost({
  resolveSessionPath,
  getRpcSession,
  startRpcSession: (id, filePath, cwd) => startRpcSession(id, filePath, cwd),
  invalidateSessionListCache,
});
