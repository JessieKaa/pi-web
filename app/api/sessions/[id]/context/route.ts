import { resolveSessionPath, buildSessionContext, buildSessionTranscript, readSessionTranscriptWindow, readSessionWindow } from "@/lib/session-reader";
import { getRpcSession } from "@/lib/rpc-manager";
import { parseSessionWindowParams, sliceSessionContext } from "@/lib/session-window";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const url = new URL(req.url);
  const deferThinking = url.searchParams.has("deferThinking");
  const deferToolResultImages = url.searchParams.has("deferMedia");
  const deferToolResults = url.searchParams.has("deferToolResults");
  const { limit, before, leafId } = parseSessionWindowParams(url.searchParams);
  const historyMode = url.searchParams.get("history") === "transcript" ? "transcript" : "context";
  const defer = { deferThinking, deferToolResultImages, deferToolResults };

  try {
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
    const filePath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !filePath) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    if (!liveRpc) {
      const window = historyMode === "transcript"
        ? readSessionTranscriptWindow(filePath!, { limit, before, leafId, ...defer })
        : readSessionWindow(filePath!, { limit, before, leafId, ...defer });
      if ("historyChanged" in window && window.historyChanged) {
        return Response.json({ error: "Transcript changed; reload history", code: "history_changed" }, { status: 409 });
      }
      return Response.json({ context: window.context, hasMore: window.hasMore, leafId: window.leafId, historyMode });
    }

    const entries = liveRpc.inner.sessionManager.getEntries();
    const selectedLeafId = leafId ?? liveRpc.inner.sessionManager.getLeafId();
    const full = historyMode === "transcript"
      ? buildSessionTranscript(entries as never, selectedLeafId, defer)
      : buildSessionContext(entries as never, selectedLeafId, defer);
    if (historyMode === "transcript" && before && !full.entryIds.includes(before)) {
      return Response.json({ error: "Transcript changed; reload history", code: "history_changed" }, { status: 409 });
    }
    const { context, hasMore } = sliceSessionContext(full, { limit, before });
    return Response.json({ context, hasMore, leafId: selectedLeafId, historyMode });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
