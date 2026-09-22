import { createAgentEventStream, type AgentEventStreamSession } from "@/lib/agent-event-stream";
import { resolveSessionPath } from "@/lib/session-reader";
import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";

type AgentEventsDependencies = {
  createStream: typeof createAgentEventStream;
  resolveSessionPath: typeof resolveSessionPath;
  getRpcSession: typeof getRpcSession;
  startRpcSession: typeof startRpcSession;
};

const defaultDependencies: AgentEventsDependencies = {
  createStream: createAgentEventStream,
  resolveSessionPath,
  getRpcSession,
  startRpcSession,
};

/** Factory keeps passive/active route semantics directly behavior-testable. */
export function createAgentEventsHandler(dependencies: AgentEventsDependencies = defaultDependencies) {
  return async function GET(
    req: Request,
    { params }: { params: Promise<{ id: string }> },
  ) {
    const { id } = await params;
    if (req.signal.aborted) return new Response(null, { status: 204 });

    const requestedMode = new URL(req.url).searchParams.get("mode");
    // Preserve the previous activation contract for callers that have not
    // migrated. The browser hook always states its intent explicitly.
    const mode = requestedMode ?? "active";
    if (mode !== "passive" && mode !== "active") {
      return new Response("Invalid event stream mode", { status: 400 });
    }

    // Passive history observation may validate a persisted session, but it
    // must never create a runtime, bind extensions, or acquire a lease.
    const session = dependencies.getRpcSession(id);
    let sessionPromise: Promise<AgentEventStreamSession | null>;
    if (session?.isAlive()) {
      sessionPromise = Promise.resolve(session);
    } else {
      const filePath = await dependencies.resolveSessionPath(id);
      if (!filePath) return new Response("Session not found", { status: 404 });
      if (req.signal.aborted) return new Response(null, { status: 204 });
      sessionPromise = mode === "active"
        ? dependencies.startRpcSession(id, filePath, undefined).then((result) => result.session)
        : Promise.resolve(null);
    }

    const stream = dependencies.createStream(req, id, sessionPromise, mode);
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  };
}

// GET /api/agent/[id]/events - SSE stream of agent events
const handleGet = createAgentEventsHandler();
export async function GET(
  req: Request,
  context: { params: Promise<{ id: string }> },
) {
  return handleGet(req, context);
}
