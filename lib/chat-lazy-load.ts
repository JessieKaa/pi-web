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
