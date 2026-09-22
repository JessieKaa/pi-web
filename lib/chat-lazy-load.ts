import type { ChatRenderPlan } from "./chat-render-plan";

export const VISIBLE_PAGE_SIZE = 50;
// The initial render window is intentionally smaller than one follow-up page
// (VISIBLE_PAGE_SIZE). The first paint only has to build this many plan
// descriptors; subsequent pages still grow by a full VISIBLE_PAGE_SIZE step.
export const INITIAL_VISIBLE_COUNT = 32;
export const CHAT_SCROLL_TAIL_TOLERANCE = 8;
export const CHAT_SCROLL_REATTACH_TOLERANCE = 96;

export function getVisibleRenderWindow(totalCount: number, visibleCount: number): {
  startIndex: number;
  hasMore: boolean;
} {
  const clampedVisibleCount = Math.min(Math.max(visibleCount, 0), Math.max(totalCount, 0));
  const startIndex = Math.max(0, totalCount - clampedVisibleCount);
  return { startIndex, hasMore: startIndex > 0 };
}

export function getNextVisibleCount(currentVisibleCount: number, pageSize = VISIBLE_PAGE_SIZE): number {
  return currentVisibleCount + pageSize;
}

/**
 * Grows the requested window from whichever is larger: the last requested
 * count or the currently effective window (which may have been raised by the
 * render-plan floor). Without this, toggling a page while a long turn holds
 * the floor above the requested count would consume the increment with no new
 * items rendered.
 */
export function growVisibleCount(
  currentRequestedCount: number,
  effectiveVisibleCount: number,
  delta = VISIBLE_PAGE_SIZE,
): number {
  return getNextVisibleCount(Math.max(currentRequestedCount, effectiveVisibleCount), delta);
}

/**
 * Keeps the current turn's prompt anchor mounted even when the requested
 * window is smaller than the gap between the last user message and the live
 * tail. A long tool/process turn appends many render-plan descriptors after
 * the user message, so the plain last-N window can push it out of view and
 * leave `lastUserMsgRef` unset (breaking the prompt anchor). This is computed
 * from the render plan, not from the raw source message count, because
 * process/thinking grouping changes how far the anchor is from the tail.
 */
export function getMinimumVisibleRenderCount(
  plan: Pick<ChatRenderPlan, "items" | "lastUserMessageIndex">,
  requestedVisibleCount: number,
): number {
  const { items, lastUserMessageIndex } = plan;
  if (lastUserMessageIndex < 0) return requestedVisibleCount;
  const anchorIndex = items.findIndex(
    (item) => item.kind === "message" && item.sourceIndex === lastUserMessageIndex,
  );
  if (anchorIndex < 0) return requestedVisibleCount;
  const requiredVisibleCount = items.length - anchorIndex;
  return Math.max(requestedVisibleCount, requiredVisibleCount);
}

export type SentinelPageAction = "none" | "expand" | "load-older";

/**
 * Decides how an intersecting sentinel should page. `sentinelArmed` starts
 * false and only becomes true after the sentinel has left the viewport, so a
 * short first screen whose sentinel is already visible cannot cascade local
 * expansion into an automatic API page. Any page consumes the arm; the caller
 * re-arms by moving the sentinel out of view.
 */
export function decideSentinelPage({
  sentinelArmed,
  renderedHasMore,
  historyHasMore,
  loadingOlderHistory,
}: {
  sentinelArmed: boolean;
  renderedHasMore: boolean;
  historyHasMore: boolean;
  loadingOlderHistory: boolean;
}): { action: SentinelPageAction; nextSentinelArmed: boolean } {
  if (!sentinelArmed) return { action: "none", nextSentinelArmed: false };
  if (renderedHasMore) return { action: "expand", nextSentinelArmed: false };
  if (historyHasMore && !loadingOlderHistory) {
    return { action: "load-older", nextSentinelArmed: false };
  }
  return { action: "none", nextSentinelArmed: false };
}

/**
 * The sentinel cascade state machine.
 *
 * A single page request changes the DOM (prepended descriptors) and the scroll
 * anchor. The browser then reports the sentinel's new intersection through the
 * IntersectionObserver, and those reports are indistinguishable from a real
 * user leave/re-enter. `phase: "absorbing"` marks the window in which those
 * self-inflicted notifications must never start a second network request.
 *
 * The window only closes on a complete *user-driven scroll cycle*: a real
 * user scroll gesture (`user-scroll-intent`) followed by an actual
 * scroll-position change (`user-scroll`) while no older-history request is in
 * flight. A programmatic scroll restore emits only `user-scroll` without the
 * intent flag, and a transcript click is never a scroll, so neither can reopen
 * the cascade.
 *
 * `intersecting` remembers the last report so that a user scroll while the
 * sentinel is already out of view re-arms it. `armed` is only set on an
 * observer leave (or a user scroll that finds the sentinel already off-screen),
 * so a visible first-screen sentinel cannot page before the user interacts.
 */
export type SentinelPagingPhase = "idle" | "absorbing";

export type SentinelPagingState = {
  phase: SentinelPagingPhase;
  armed: boolean;
  intersecting: boolean;
  /**
   * A real user scroll gesture was seen while absorbing but the matching
   * scroll-position change has not arrived yet.
   */
  pendingUserScroll: boolean;
};

export type SentinelPagingContext = {
  /**
   * Raw source-message `hasMore`. The observer intentionally keeps this
   * mixed-count contract; the explicit click carries its own render-plan count
   * instead (see `SentinelPagingEvent`).
   */
  renderedHasMore: boolean;
  historyHasMore: boolean;
  loadingOlderHistory: boolean;
};

export type SentinelPagingEvent =
  | { type: "user-scroll-intent" }
  | { type: "user-scroll" }
  | { type: "observer"; intersecting: boolean }
  | { type: "click"; planHasMore: boolean };

export function createSentinelPagingState(): SentinelPagingState {
  return { phase: "idle", armed: false, intersecting: true, pendingUserScroll: false };
}

function decideSentinelPageAction(renderedHasMore: boolean, context: SentinelPagingContext): SentinelPageAction {
  if (renderedHasMore) return "expand";
  if (context.historyHasMore && !context.loadingOlderHistory) return "load-older";
  return "none";
}

function armOnIdle(state: SentinelPagingState): SentinelPagingState {
  return {
    ...state,
    phase: "idle",
    armed: state.intersecting ? state.armed : true,
    pendingUserScroll: false,
  };
}

export function reduceSentinelPaging(
  state: SentinelPagingState,
  event: SentinelPagingEvent,
  context: SentinelPagingContext,
): { action: SentinelPageAction; state: SentinelPagingState } {
  switch (event.type) {
    case "user-scroll-intent": {
      // Only a real gesture is recorded, and never while an older-history
      // request is in flight: that request's own prepend churn must stay
      // absorbed even if the user keeps scrolling.
      if (state.phase !== "absorbing" || context.loadingOlderHistory) {
        return { action: "none", state };
      }
      return { action: "none", state: { ...state, pendingUserScroll: true } };
    }

    case "user-scroll": {
      // A scroll-position change only closes the absorbing window when it
      // follows a real gesture. A programmatic restore has no intent.
      if (state.phase === "absorbing") {
        if (context.loadingOlderHistory || !state.pendingUserScroll) {
          return { action: "none", state };
        }
      }
      return { action: "none", state: armOnIdle(state) };
    }

    case "click": {
      // The explicit click pages against the render plan's own `hasMore`, not
      // the raw source-message count the observer uses.
      const action = decideSentinelPageAction(event.planHasMore, context);
      if (action === "none") return { action, state };
      // An explicit click always pages immediately and opens an absorbing
      // window so the observer cannot add a second automatic page for the very
      // same operation.
      return {
        action,
        state: { phase: "absorbing", armed: false, intersecting: true, pendingUserScroll: false },
      };
    }

    case "observer": {
      const intersecting = event.intersecting;
      if (!intersecting) {
        // Leave. Absorbed internal leaves never arm; a genuine leave does.
        return {
          action: "none",
          state: state.phase === "absorbing"
            ? { ...state, intersecting }
            : { ...state, intersecting, armed: true },
        };
      }
      // Enter. Internal re-entries during the absorbing window are ignored.
      if (state.phase === "absorbing" || !state.armed) {
        return { action: "none", state: { ...state, intersecting } };
      }
      const action = decideSentinelPageAction(context.renderedHasMore, context);
      if (action === "none") return { action, state: { ...state, intersecting } };
      return {
        action,
        state: { phase: "absorbing", armed: false, intersecting, pendingUserScroll: false },
      };
    }
  }
}

export function captureScrollDistance(scrollHeight: number, scrollTop: number): number {
  return scrollHeight - scrollTop;
}

export function restoreScrollTop(scrollHeight: number, savedDistance: number): number {
  return Math.max(0, scrollHeight - savedDistance);
}

export function isScrollAtTail(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = CHAT_SCROLL_TAIL_TOLERANCE,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - tolerance;
}

export function getLiveFollowAttached(
  wasAttached: boolean,
  previousScrollTop: number,
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  reattachTolerance = CHAT_SCROLL_REATTACH_TOLERANCE,
): boolean {
  if (isScrollAtTail(scrollTop, clientHeight, scrollHeight)) return true;
  if (scrollTop < previousScrollTop) return false;
  if (
    !wasAttached
    && scrollTop > previousScrollTop
    && isScrollAtTail(scrollTop, clientHeight, scrollHeight, reattachTolerance)
  ) return true;
  return wasAttached;
}

export function getPromptAnchorSpacerHeight(
  targetTop: number,
  contentEnd: number,
  clientHeight: number,
): number {
  const clampedTargetTop = Math.max(0, targetTop);
  if (clampedTargetTop === 0) return 0;

  return Math.max(0, Math.ceil(
    clampedTargetTop + clientHeight - Math.max(0, contentEnd),
  ));
}
