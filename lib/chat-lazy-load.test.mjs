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
