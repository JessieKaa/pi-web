import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  DEFAULT_EXPANDED_WIDGET_LINES,
  DesktopWidgetCards,
  ExtensionWidgets,
  filterSubagentWidgets,
  formatExtensionWidgetContent,
  getNextExpandedWidgetKey,
  getUpdatedExtensionWidgetKeys,
  isPiSubagentWidgetKey,
  parseExtensionWidgetCard,
  snapshotExtensionWidgetContents,
} = await jiti.import("./ExtensionWidgets.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function renderWidgets(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(ExtensionWidgets, props),
    ),
  );
}

test("renders short extension widgets without a truncation marker", () => {
  const html = renderWidgets({
    widgets: [{ key: "short", lines: ["first", "second"], placement: "aboveEditor" }],
  });

  assert.match(html, /first\nsecond/);
  assert.doesNotMatch(html, /widget truncated/);
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /data-direction="up"/);
  assert.doesNotMatch(html, /[\u2191\u2193]/);
});

test("collapses long widgets by default", () => {
  const lines = Array.from(
    { length: 12 },
    (_, index) => `line-${index + 1}`,
  );
  const html = renderWidgets({
    widgets: [{ key: "long", lines, placement: "belowEditor" }],
  });

  assert.ok(lines.length > DEFAULT_EXPANDED_WIDGET_LINES);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-direction="down"/);
  assert.doesNotMatch(html, /<pre/);
  assert.doesNotMatch(html, /line-1/);
  assert.doesNotMatch(html, /line-10/);
  assert.doesNotMatch(html, /line-12/);
});

test("keeps all widget lines available for the scrollable expanded panel", () => {
  const lines = Array.from(
    { length: 12 },
    (_, index) => `line-${index + 1}`,
  );
  const content = formatExtensionWidgetContent(lines);

  assert.match(content, /line-10/);
  assert.match(content, /line-12/);
  assert.doesNotMatch(content, /widget truncated/);
});

test("keeps compact widgets expanded by default", () => {
  const lines = Array.from(
    { length: DEFAULT_EXPANDED_WIDGET_LINES },
    (_, index) => `line-${index + 1}`,
  );
  const html = renderWidgets({
    widgets: [{ key: "compact", lines, placement: "aboveEditor" }],
  });

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /<pre/);
});

test("expands at most one compact widget", () => {
  const html = renderWidgets({
    widgets: [
      { key: "first", lines: ["one", "two"], placement: "aboveEditor" },
      { key: "second", lines: ["three", "four"], placement: "belowEditor" },
    ],
  });

  assert.equal((html.match(/aria-expanded="true"/g) ?? []).length, 1);
  assert.equal((html.match(/<section/g) ?? []).length, 1);
  assert.match(html, /aria-labelledby="[^"]*trigger-0"/);
  assert.doesNotMatch(html, /aria-labelledby="[^"]*trigger-1"/);
});

test("switching widgets closes the previously expanded widget", () => {
  assert.equal(getNextExpandedWidgetKey(null, "first"), "first");
  assert.equal(getNextExpandedWidgetKey("first", "second"), "second");
  assert.equal(getNextExpandedWidgetKey("second", "second"), null);
});

test("detects only existing widgets whose line content changed", () => {
  const previous = snapshotExtensionWidgetContents([
    { key: "changed", lines: ["one"], placement: "aboveEditor" },
    { key: "same", lines: ["ready"], placement: "belowEditor" },
    { key: "removed", lines: ["gone"], placement: "belowEditor" },
  ]);
  const next = snapshotExtensionWidgetContents([
    { key: "same", lines: ["ready"], placement: "aboveEditor" },
    { key: "changed", lines: ["one", "two"], placement: "belowEditor" },
    { key: "added", lines: ["new"], placement: "aboveEditor" },
  ]);

  assert.deepEqual(getUpdatedExtensionWidgetKeys(previous, next), ["changed"]);
  assert.deepEqual(getUpdatedExtensionWidgetKeys(null, next), []);
});

test("compares widget lines without delimiter collisions", () => {
  const previous = new Map([["status", ["one", "two"]]]);
  const next = new Map([["status", ["one\ntwo"]]]);

  assert.deepEqual(getUpdatedExtensionWidgetKeys(previous, next), ["status"]);
});

test("uses a compact key-only trigger with a placement icon", () => {
  const html = renderWidgets({
    widgets: [{ key: "long-extension-widget-key", lines: ["ready"], placement: "belowEditor" }],
  });

  assert.match(html, /extension-widget-triggers/);
  assert.match(html, /<button/);
  assert.match(html, /<svg[^>]*extension-widget-placement-icon/);
  assert.match(html, /data-direction="down"/);
  assert.doesNotMatch(html, /[\u2191\u2193]/);
  assert.match(html, /Below editor widget/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /title="long-extension-widget-key - Below editor widget/);
  assert.match(html, /extension-widget-key/);
  assert.match(html, /extension-widget-update-pulse/);
  assert.doesNotMatch(html, /extension-widget-preview/);
  assert.doesNotMatch(html, /extension-widget-line-count/);
  assert.doesNotMatch(html, />ready</);
});

test("keeps a one-line widget collapsed as an expandable trigger", () => {
  const html = renderWidgets({
    widgets: [{ key: "status", lines: ["ready"], placement: "aboveEditor" }],
  });

  assert.match(html, /<button/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /<pre/);
});

test("keeps generic widgets independent from conversation plans", () => {
  const html = renderWidgets({
    widgets: [{ key: "details", lines: ["one", "two"], placement: "aboveEditor" }],
  });

  assert.match(html, /extension-widget-panel/);
  assert.match(html, /one\ntwo/);
});

test("identifies the pi-subagents TUI widgets that the web tree replaces", () => {
  assert.equal(isPiSubagentWidgetKey("subagent-async"), true);
  assert.equal(isPiSubagentWidgetKey("subagent-fleet-status"), true);
  assert.equal(isPiSubagentWidgetKey("web-activity"), false);
  assert.equal(isPiSubagentWidgetKey("details"), false);
});

test("drops pi-subagents TUI widgets while keeping other footer widgets", () => {
  const widgets = [
    { key: "subagent-async", lines: ["worker"], placement: "aboveEditor" },
    { key: "web-activity", lines: ["fetch"], placement: "belowEditor" },
    { key: "subagent-fleet-status", lines: ["fleet"], placement: "belowEditor" },
  ];
  assert.deepEqual(filterSubagentWidgets(widgets).map((widget) => widget.key), ["web-activity"]);
});

test("expandFirst opens the first widget even when it is long", () => {
  const lines = Array.from({ length: 12 }, (_, index) => `line-${index + 1}`);
  const html = renderWidgets({
    expandFirst: true,
    widgets: [{ key: "long", lines, placement: "aboveEditor" }],
  });
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /line-1/);
});

test("parses WorkBuddy widget lines into a context-card model", () => {
  const card = parseExtensionWidgetCard([
    "WorkBuddy AI · 国际版 · 仅免费模型",
    "账号  已登录  u123",
    "令牌  2027/9/12 16:51:48 过期（自动续期）",
    "积分  合计 350",
    "  Bonus Pack  剩余 250 / 250",
    "  ████████████████████████████",
    "  Free Plan Subscription  剩余 100 / 100",
    "  ████████████████████████████",
    "模型  hy3",
    "设置  /workbuddy",
  ], "workbuddy");
  assert.equal(card.heading, "WorkBuddy AI");
  assert.equal(card.metric, "350");
  assert.equal(card.kicker, "国际版 · 仅免费模型");
  assert.deepEqual(card.meters, [
    { name: "Bonus Pack", remain: 250, size: 250 },
    { name: "Free Plan Subscription", remain: 100, size: 100 },
  ]);
  assert.deepEqual(card.rows.map((row) => row.label), ["账号", "令牌", "模型"]);
});

test("renders gutter widgets with the conversation-context card chrome", () => {
  const html = renderToStaticMarkup(
    React.createElement(DesktopWidgetCards, {
      widgets: [{
        key: "workbuddy",
        title: "WorkBuddy AI",
        placement: "aboveEditor",
        lines: [
          "WorkBuddy AI · 国际版 · 仅免费模型",
          "账号  已登录",
          "积分  合计 350",
          "  Bonus Pack  剩余 250 / 250",
        ],
      }],
    }),
  );
  assert.match(html, /desktop-conversation-context desktop-widget-card/);
  assert.match(html, /data-extension-widget-card="workbuddy"/);
  assert.match(html, /WorkBuddy AI/);
  assert.match(html, /desktop-context-progress/);
  assert.match(html, /Bonus Pack/);
  assert.match(html, /desktop-widget-card-row/);
  assert.doesNotMatch(html, /\u2588/);
  assert.doesNotMatch(html, /extension-widget-trigger/);
});

test("stacks long widget values instead of wrapping CJK labels", () => {
  const html = renderToStaticMarkup(
    React.createElement(DesktopWidgetCards, {
      widgets: [{
        key: "workbuddy",
        placement: "aboveEditor",
        lines: [
          "WorkBuddy AI · 国际版 · 仅免费模型",
          "账号  已登录",
          "令牌  2027/9/12 16:51:48 过期（自动续期）",
          "模型  Deepseek-V4.1-Flash · x0.00 | Hy4 preview · x0.00 | Hy3 · x0.00",
        ],
      }],
    }),
  );
  assert.match(html, /desktop-widget-card-kicker/);
  assert.match(html, /desktop-widget-card-row is-stack/);
  assert.match(html, /<span>Deepseek-V4.1-Flash · x0.00<\/span>/);
  assert.match(html, /<span>Hy3 · x0.00<\/span>/);
  assert.doesNotMatch(html, /账号 <strong>/);
});
