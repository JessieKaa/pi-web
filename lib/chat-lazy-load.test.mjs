import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./chat-lazy-load.ts");
}

test("shows only the last visible render items", async () => {
  const { getVisibleRenderWindow } = await loadSubject();
  assert.deepEqual(getVisibleRenderWindow(200, 50), { startIndex: 150, hasMore: true });
});

test("keeps a smaller first window but a full follow-up page", async () => {
  const { INITIAL_VISIBLE_COUNT, VISIBLE_PAGE_SIZE, getNextVisibleCount } = await loadSubject();
  assert.equal(INITIAL_VISIBLE_COUNT, 32);
  assert.equal(VISIBLE_PAGE_SIZE, 50);
  assert.equal(getNextVisibleCount(INITIAL_VISIBLE_COUNT), 82);
});

test("shows all render items when the visible count reaches the total", async () => {
  const { getVisibleRenderWindow } = await loadSubject();
  assert.deepEqual(getVisibleRenderWindow(30, 50), { startIndex: 0, hasMore: false });
  assert.deepEqual(getVisibleRenderWindow(50, 50), { startIndex: 0, hasMore: false });
  assert.deepEqual(getVisibleRenderWindow(0, 50), { startIndex: 0, hasMore: false });
});

test("continues paging when render items outnumber source messages", async () => {
  const { getNextVisibleCount, getVisibleRenderWindow } = await loadSubject();
  let visibleCount = 50;

  visibleCount = getNextVisibleCount(visibleCount);
  assert.deepEqual(getVisibleRenderWindow(120, visibleCount), { startIndex: 20, hasMore: true });

  visibleCount = getNextVisibleCount(visibleCount);
  assert.deepEqual(getVisibleRenderWindow(120, visibleCount), { startIndex: 0, hasMore: false });
});

test("restores the viewport after prepending content", async () => {
  const { captureScrollDistance, restoreScrollTop } = await loadSubject();
  const savedDistance = captureScrollDistance(2000, 500);

  assert.equal(savedDistance, 1500);
  assert.equal(restoreScrollTop(2500, savedDistance), 1000);
});

test("restores top and bottom boundary positions", async () => {
  const { captureScrollDistance, restoreScrollTop } = await loadSubject();
  assert.equal(restoreScrollTop(3000, captureScrollDistance(2000, 0)), 1000);
  assert.equal(restoreScrollTop(3000, captureScrollDistance(2000, 2000)), 3000);
});

test("treats only the real message tail as live-follow attached", async () => {
  const {
    CHAT_SCROLL_REATTACH_TOLERANCE,
    CHAT_SCROLL_TAIL_TOLERANCE,
    getLiveFollowAttached,
    isScrollAtTail,
  } = await loadSubject();

  assert.equal(CHAT_SCROLL_TAIL_TOLERANCE, 8);
  assert.equal(CHAT_SCROLL_REATTACH_TOLERANCE, 96);
  assert.deepEqual(
    [392, 391.99, 400].map((scrollTop) => isScrollAtTail(scrollTop, 600, 1000)),
    [true, false, true],
  );
  assert.equal(isScrollAtTail(0, 600, 400), true);

  // Layout growth alone must not detach a view that was already following.
  assert.equal(getLiveFollowAttached(true, 400, 400, 600, 1040), true);
  // Any upward movement outside the strict tail tolerance detaches, even inside
  // the wider downward-only reattach window.
  assert.equal(getLiveFollowAttached(true, 400, 380, 600, 1000), false);
  assert.equal(getLiveFollowAttached(false, 380, 370, 600, 1000), false);
  // A detached view stays detached until downward movement enters the reattach window.
  assert.equal(getLiveFollowAttached(false, 280, 303, 600, 1000), false);
  assert.equal(getLiveFollowAttached(false, 303, 304, 600, 1000), true);
  // Reaching the old tail still reattaches after one to four new rendered lines.
  for (const lines of [1, 2, 3, 4]) {
    assert.equal(getLiveFollowAttached(false, 380, 400, 600, 1000 + lines * 24), true);
  }
  assert.equal(getLiveFollowAttached(false, 380, 400, 600, 1120), false);
  // Streaming growth without downward user movement must not reattach.
  assert.equal(getLiveFollowAttached(false, 400, 400, 600, 1096), false);
  assert.equal(getLiveFollowAttached(false, 391, 392, 600, 1000), true);
});

test("prompt anchor spacer uses the rendered content end", async () => {
  const { getPromptAnchorSpacerHeight } = await loadSubject();
  const initial = getPromptAnchorSpacerHeight(400, 700, 600);
  const afterRender = getPromptAnchorSpacerHeight(400, 700, 600);

  assert.equal(initial, 300);
  assert.equal(afterRender, initial);
});

test("prompt anchor spacer includes the viewport deficit for short conversations", async () => {
  const { getPromptAnchorSpacerHeight } = await loadSubject();
  const targetTop = 168;
  const clientHeight = 579;

  let contentHeight = 411;
  let spacerHeight = getPromptAnchorSpacerHeight(targetTop, contentHeight, clientHeight);
  assert.equal(spacerHeight, 336);
  assert.equal(contentHeight + spacerHeight - clientHeight, targetTop);

  contentHeight += 24;
  spacerHeight = getPromptAnchorSpacerHeight(targetTop, contentHeight, clientHeight);
  assert.equal(spacerHeight, 312);
  assert.equal(contentHeight + spacerHeight - clientHeight, targetTop);
});

test("prompt anchor spacer clamps at zero once content can reach the target", async () => {
  const { getPromptAnchorSpacerHeight } = await loadSubject();
  assert.equal(getPromptAnchorSpacerHeight(100, 750, 600), 0);
  assert.equal(getPromptAnchorSpacerHeight(-20, 200, 600), 0);
});

test("prompt anchor spacer rounds fractional layout measurements up", async () => {
  const { getPromptAnchorSpacerHeight } = await loadSubject();
  assert.equal(getPromptAnchorSpacerHeight(400.25, 700, 600), 301);
});

const messageItem = (sourceIndex) => ({ kind: "message", sourceIndex });
const processItem = () => ({ kind: "process" });

test("keeps the requested window when the last user message already fits", async () => {
  const { getMinimumVisibleRenderCount } = await loadSubject();
  const plan = {
    items: Array.from({ length: 60 }, (_, index) => messageItem(index)),
    lastUserMessageIndex: 30,
  };

  // requested 32 starts at item 28, so item 30 is already visible.
  assert.equal(getMinimumVisibleRenderCount(plan, 32), 32);
});

test("grows the window until the last user message is rendered", async () => {
  const { getMinimumVisibleRenderCount } = await loadSubject();
  const items = [
    messageItem(0),
    messageItem(1),
    messageItem(2),
    messageItem(3),
    messageItem(4),
    processItem(),
    ...Array.from({ length: 44 }, (_, index) => messageItem(index + 5)),
  ];
  const plan = { items, lastUserMessageIndex: 0 };

  // requested 32 starts at item 18 and would unmount the anchor at item 0.
  assert.equal(getMinimumVisibleRenderCount(plan, 32), items.length);

  const nearer = { items: items.slice(0, 34), lastUserMessageIndex: 32 };
  assert.equal(getMinimumVisibleRenderCount(nearer, 32), 32);
});

test("only expands for the last user message, never for a plain requested count", async () => {
  const { getMinimumVisibleRenderCount } = await loadSubject();
  assert.equal(getMinimumVisibleRenderCount({ items: [], lastUserMessageIndex: -1 }, 32), 32);
  assert.equal(
    getMinimumVisibleRenderCount({ items: [messageItem(9), messageItem(10)], lastUserMessageIndex: 5 }, 32),
    32,
  );
});

test("does not auto-page an already-visible sentinel before it has left", async () => {
  const { decideSentinelPage } = await loadSubject();

  // First screen: sentinel visible, more render items exist, but no arm yet.
  assert.deepEqual(
    decideSentinelPage({
      sentinelArmed: false,
      renderedHasMore: true,
      historyHasMore: true,
      loadingOlderHistory: false,
    }),
    { action: "none", nextSentinelArmed: false },
  );
});

test("grows a page from the effective window so a render-plan floor cannot absorb it", async () => {
  const { growVisibleCount, INITIAL_VISIBLE_COUNT, VISIBLE_PAGE_SIZE } = await loadSubject();

  // No floor: a plain page still advances by exactly one page size.
  assert.equal(growVisibleCount(INITIAL_VISIBLE_COUNT, INITIAL_VISIBLE_COUNT), 82);
  // The long-turn floor (100) is above the requested count, so requesting a
  // page from the raw requested count would render nothing new. Grow from the
  // effective window instead.
  assert.equal(growVisibleCount(INITIAL_VISIBLE_COUNT, 100), 150);
  assert.equal(growVisibleCount(INITIAL_VISIBLE_COUNT, 100, 7), 107);
  assert.equal(VISIBLE_PAGE_SIZE, 50);
});

test("pages only after the sentinel left and was re-entered", async () => {
  const { decideSentinelPage } = await loadSubject();

  // Local render-plan expansion must disarm so the next observer callback
  // cannot cascade another page while the sentinel is still on screen.
  assert.deepEqual(
    decideSentinelPage({
      sentinelArmed: true,
      renderedHasMore: true,
      historyHasMore: true,
      loadingOlderHistory: false,
    }),
    { action: "expand", nextSentinelArmed: false },
  );

  // Once the in-memory plan is exhausted, fall through to the API page.
  assert.deepEqual(
    decideSentinelPage({
      sentinelArmed: true,
      renderedHasMore: false,
      historyHasMore: true,
      loadingOlderHistory: false,
    }),
    { action: "load-older", nextSentinelArmed: false },
  );
});

test("does not start a second API page while one is loading", async () => {
  const { decideSentinelPage } = await loadSubject();
  assert.deepEqual(
    decideSentinelPage({
      sentinelArmed: true,
      renderedHasMore: false,
      historyHasMore: true,
      loadingOlderHistory: true,
    }),
    { action: "none", nextSentinelArmed: false },
  );
  assert.deepEqual(
    decideSentinelPage({
      sentinelArmed: true,
      renderedHasMore: false,
      historyHasMore: false,
      loadingOlderHistory: false,
    }),
    { action: "none", nextSentinelArmed: false },
  );
});

const pagingContext = (overrides = {}) => ({
  renderedHasMore: false,
  historyHasMore: true,
  loadingOlderHistory: false,
  ...overrides,
});

test("absorbs an explicit click's own observer leave/re-enter instead of loading older", async () => {
  const { createSentinelPagingState, reduceSentinelPaging } = await loadSubject();
  const armedContext = pagingContext({ renderedHasMore: true });

  // 1. The sentinel has left the viewport under user control.
  let state = reduceSentinelPaging(
    createSentinelPagingState(),
    { type: "observer", intersecting: false },
    armedContext,
  ).state;
  assert.equal(state.armed, true);

  // 2. An explicit click always pages immediately (local expand here).
  let result = reduceSentinelPaging(state, { type: "click" }, armedContext);
  assert.equal(result.action, "expand");
  state = result.state;
  assert.equal(state.phase, "absorbing");

  // 3. The expand's own DOM / scroll-anchor notifications. The plan is now
  // exhausted, so without the absorbing window this re-enter would fetch older
  // history from the network. Every one of them must stay silent.
  const exhausted = pagingContext();
  for (const intersecting of [false, true, false, true]) {
    result = reduceSentinelPaging(state, { type: "observer", intersecting }, exhausted);
    assert.equal(result.action, "none");
    state = result.state;
  }
});

test("re-enables auto paging only after a genuine user leave and re-enter", async () => {
  const { createSentinelPagingState, reduceSentinelPaging } = await loadSubject();
  const armedContext = pagingContext({ renderedHasMore: true });
  const exhausted = pagingContext();

  let state = reduceSentinelPaging(
    createSentinelPagingState(),
    { type: "observer", intersecting: false },
    armedContext,
  ).state;
  state = reduceSentinelPaging(state, { type: "click" }, armedContext).state;
  state = reduceSentinelPaging(state, { type: "observer", intersecting: false }, exhausted).state;
  state = reduceSentinelPaging(state, { type: "observer", intersecting: true }, exhausted).state;

  // A real user scroll closes the absorbing window; the sentinel is still on
  // screen so the scroll alone does not arm it.
  state = reduceSentinelPaging(state, { type: "user-scroll" }, exhausted).state;
  assert.equal(state.phase, "idle");
  assert.equal(state.armed, false);

  // Real user leaves, then re-enters. Now the API page is allowed.
  state = reduceSentinelPaging(state, { type: "observer", intersecting: false }, exhausted).state;
  assert.equal(state.armed, true);
  const result = reduceSentinelPaging(state, { type: "observer", intersecting: true }, exhausted);
  assert.equal(result.action, "load-older");
  assert.equal(result.state.phase, "absorbing");
});

test("a later explicit click still pages immediately after an absorbed cascade", async () => {
  const { createSentinelPagingState, reduceSentinelPaging } = await loadSubject();
  const exhausted = pagingContext();

  let state = reduceSentinelPaging(
    createSentinelPagingState(),
    { type: "click" },
    pagingContext({ renderedHasMore: true }),
  ).state;
  state = reduceSentinelPaging(state, { type: "observer", intersecting: true }, exhausted).state;

  // Second click is not blocked by the still-absorbing window.
  const result = reduceSentinelPaging(state, { type: "click" }, exhausted);
  assert.equal(result.action, "load-older");
  assert.equal(result.state.phase, "absorbing");
});

test("a user scroll while the sentinel is off-screen re-arms it for the next enter", async () => {
  const { createSentinelPagingState, reduceSentinelPaging } = await loadSubject();
  const exhausted = pagingContext();

  // Clicking can push the sentinel out of view; the internal leave is absorbed.
  let state = reduceSentinelPaging(
    createSentinelPagingState(),
    { type: "click" },
    pagingContext({ renderedHasMore: true }),
  ).state;
  state = reduceSentinelPaging(state, { type: "observer", intersecting: false }, exhausted).state;
  assert.equal(state.armed, false);

  state = reduceSentinelPaging(state, { type: "user-scroll" }, exhausted).state;
  assert.equal(state.armed, true);
  const result = reduceSentinelPaging(state, { type: "observer", intersecting: true }, exhausted);
  assert.equal(result.action, "load-older");
});

test("never starts a concurrent API page while older history is loading", async () => {
  const { createSentinelPagingState, reduceSentinelPaging } = await loadSubject();
  const loading = pagingContext({ loadingOlderHistory: true });

  let state = reduceSentinelPaging(
    createSentinelPagingState(),
    { type: "observer", intersecting: false },
    loading,
  ).state;
  const first = reduceSentinelPaging(state, { type: "observer", intersecting: true }, loading);
  assert.equal(first.action, "none");
  const second = reduceSentinelPaging(first.state, { type: "observer", intersecting: false }, loading);
  assert.equal(second.action, "none");
  const third = reduceSentinelPaging(second.state, { type: "observer", intersecting: true }, loading);
  assert.equal(third.action, "none");
});

test("streaming content consumes the prompt anchor before advancing the tail", async () => {
  const { getPromptAnchorSpacerHeight } = await loadSubject();
  const targetTop = 400;
  const clientHeight = 600;

  let contentHeight = 700;
  let spacerHeight = getPromptAnchorSpacerHeight(targetTop, contentHeight, clientHeight);
  assert.equal(spacerHeight, 300);
  assert.equal(contentHeight + spacerHeight - clientHeight, targetTop);

  contentHeight += 120;
  spacerHeight = getPromptAnchorSpacerHeight(targetTop, contentHeight, clientHeight);
  assert.equal(spacerHeight, 180);
  assert.equal(contentHeight + spacerHeight - clientHeight, targetTop);

  contentHeight += 180;
  spacerHeight = getPromptAnchorSpacerHeight(targetTop, contentHeight, clientHeight);
  assert.equal(spacerHeight, 0);
  assert.equal(contentHeight - clientHeight, targetTop);

  contentHeight += 40;
  spacerHeight = getPromptAnchorSpacerHeight(targetTop, contentHeight, clientHeight);
  assert.equal(spacerHeight, 0);
  assert.equal(contentHeight - clientHeight, targetTop + 40);
});
