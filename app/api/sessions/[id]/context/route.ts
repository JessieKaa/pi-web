import { existsSync } from "fs";
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
    const liveFile = liveRpc
      ? (liveRpc.sessionFile || liveRpc.inner.sessionManager.getSessionFile() || "")
      : "";
    const filePath = liveFile && existsSync(liveFile)
      ? liveFile
      : liveRpc
        ? null
        : await resolveSessionPath(id);
    if (!liveRpc && !filePath) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }

    const selectedLeafId = leafId ?? liveRpc?.inner.sessionManager.getLeafId?.();
    if (filePath) {
      let window: ReturnType<typeof readSessionWindow> | ReturnType<typeof readSessionTranscriptWindow> | undefined;
      try {
        window = historyMode === "transcript"
          ? readSessionTranscriptWindow(filePath, { limit, before, leafId: selectedLeafId, ...defer })
          : readSessionWindow(filePath, { limit, before, leafId: selectedLeafId, ...defer });
      } catch (error) {
        if (!liveRpc) throw error;
      }
      // The current live leaf or cursor can precede its JSONL flush or rewrite.
      const missingLiveLeaf = liveRpc && selectedLeafId != null && window?.leafId !== selectedLeafId;
      if (window && (!liveRpc || (!missingLiveLeaf && window.context.entryIds.length > 0 && !("historyChanged" in window && window.historyChanged)))) {
        if ("historyChanged" in window && window.historyChanged) {
          return Response.json({ error: "Transcript changed; reload history", code: "history_changed" }, { status: 409 });
        }
        return Response.json({ context: window.context, hasMore: window.hasMore, leafId: window.leafId, historyMode });
      }
    }

    if (!liveRpc) return Response.json({ error: "Session not found" }, { status: 404 });
    const entries = liveRpc.inner.sessionManager.getEntries();
    const liveLeafId = selectedLeafId ?? liveRpc.inner.sessionManager.getLeafId();
    const full = historyMode === "transcript"
      ? buildSessionTranscript(entries as never, liveLeafId, defer)
      : buildSessionContext(entries as never, liveLeafId, defer);
    if (historyMode === "transcript" && before && !full.entryIds.includes(before)) {
      return Response.json({ error: "Transcript changed; reload history", code: "history_changed" }, { status: 409 });
    }
    const { context, hasMore } = sliceSessionContext(full, {
      limit, before, mode: historyMode === "transcript" ? "entries" : "visible",
    });
    return Response.json({ context, hasMore, leafId: liveLeafId, historyMode });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 500 });
  }
}
