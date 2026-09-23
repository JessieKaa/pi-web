import {
  isEventIncludedInSnapshot,
  toClientAgentEvent,
  type AgentEventLike,
} from "./agent-event-wire";
import { getPromptGeneration } from "./prompt-generation";

export interface AgentEventStreamSession {
  readonly isStreaming: boolean;
  readonly streamingMessage: unknown;
  onEvent(listener: (event: AgentEventLike) => void): () => void;
  setSessionLease?(expiresAt?: number): void;
  hasActiveSessionLease?(now?: number): boolean;
}

export type AgentEventStreamMode = "passive" | "active";

export interface AgentEventStreamOptions {
  /** Active streams own the runtime lease; passive observers never renew it. */
  mode?: AgentEventStreamMode;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const openEventStreams = new Set<() => void>();

/** Drop live SSE responses during process shutdown so a restart does not leave them hanging. */
export function closeAllAgentEventStreams(): void {
  for (const close of openEventStreams) close();
  openEventStreams.clear();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Open the SSE transport immediately, then publish the session snapshot only
 * after the agent is ready and its event listener has been installed.
 */
export function createAgentEventStream(
  req: Request,
  sessionId: string,
  sessionPromise: Promise<AgentEventStreamSession | null>,
  modeOrOptions: AgentEventStreamMode | AgentEventStreamOptions = "active",
): ReadableStream<Uint8Array> {
  const mode = typeof modeOrOptions === "string"
    ? modeOrOptions
    : modeOrOptions.mode ?? "active";
  let cancelStream: (closeController: boolean) => void = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;
      let leasedSession: AgentEventStreamSession | undefined;

      let closeStream: (() => void) | null = null;
      const cleanup = (closeController: boolean) => {
        if (closed) return;
        closed = true;
        if (closeStream) openEventStreams.delete(closeStream);
        if (heartbeat !== null) clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribe = null;
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        if (closeController) {
          try { controller.close(); } catch { /* stream already closed */ }
        }
      };
      cancelStream = cleanup;
      closeStream = () => cleanup(true);
      openEventStreams.add(closeStream);

      const enqueueText = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup(false);
        }
      };
      const encode = (data: unknown) => {
        enqueueText(`data: ${JSON.stringify(data)}\n\n`);
      };
      const forwardEvent = (event: AgentEventLike, snapshot: unknown) => {
        if (isEventIncludedInSnapshot(event, snapshot)) return;
        const clientEvent = toClientAgentEvent(event);
        if (clientEvent) {
          // Stamp the generation that was current when the event was emitted;
          // the client drops terminal events older than its latest prompt.
          encode({ ...clientEvent, promptGeneration: getPromptGeneration(sessionId) });
        }
      };

      const publishSession = async () => {
        try {
          const session = await sessionPromise;
          if (closed) return;

          if (session === null) {
            encode({
              type: "connected",
              sessionId,
              runtime: "absent",
              isStreaming: false,
            });
            return;
          }

          const bufferedEvents: AgentEventLike[] = [];
          let snapshotPublished = false;
          const handleEvent = (event: AgentEventLike) => {
            if (!snapshotPublished) {
              bufferedEvents.push(event);
              return;
            }
            forwardEvent(event, snapshot);
          };

          const stopListening = session.onEvent(handleEvent);
          if (closed) {
            stopListening();
            return;
          }
          unsubscribe = stopListening;

          const snapshot = session.streamingMessage;
          if (mode === "active") {
            session.setSessionLease?.();
            leasedSession = session;
          }
          encode({
            type: "connected",
            sessionId,
            runtime: "live",
            isStreaming: session.isStreaming,
          });
          for (const event of bufferedEvents) forwardEvent(event, snapshot);
          if (snapshot !== undefined && snapshot !== null) {
            encode({ type: "message_start", message: snapshot });
          }
          snapshotPublished = true;
        } catch (error) {
          if (closed) return;
          encode({
            type: "startup_error",
            errorMessage: `Failed to start agent: ${errorMessage(error)}`,
          });
          cleanup(true);
        }
      };

      // Attach the rejection handler before checking the request signal. The
      // route may already have started a shared cold-start promise.
      void publishSession();

      abortHandler = () => cleanup(true);
      if (req.signal.aborted) {
        cleanup(true);
        return;
      }
      req.signal.addEventListener("abort", abortHandler, { once: true });

      heartbeat = setInterval(() => {
        if (leasedSession?.hasActiveSessionLease?.()) leasedSession.setSessionLease?.();
        enqueueText(":\n\n");
        encode({ type: "heartbeat" });
      }, HEARTBEAT_INTERVAL_MS);

      // Force the response headers through without claiming that the agent is
      // ready. The client waits for the later `connected` data event.
      enqueueText(":\n\n");
    },
    cancel() {
      cancelStream(false);
    },
  });
}
