"use client";

import { Puzzle } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { useI18n } from "@/hooks/useI18n";
import type { ExtensionWidgetItem } from "@/lib/types";

export const DEFAULT_EXPANDED_WIDGET_LINES = 3;
export const WIDGET_UPDATE_IDLE_MS = 1100;

/** TUI widgets from pi-subagents; the web tree/card replaces them. */
export const PI_SUBAGENT_WIDGET_KEYS = new Set([
  "subagent-async",
  "subagent-fleet-status",
]);

export function isPiSubagentWidgetKey(key: string): boolean {
  return PI_SUBAGENT_WIDGET_KEYS.has(key);
}

export function filterSubagentWidgets<T extends { key: string }>(widgets: T[]): T[] {
  return widgets.filter((widget) => !isPiSubagentWidgetKey(widget.key));
}

export function formatExtensionWidgetContent(lines: string[]): string {
  return lines.join("\n");
}

const BAR_RE = /^[\s\u2588\u2591\u2592\u2593]+$/;
const METER_RE = /^(.*?)\s+剩余\s+(\d+)(?:\s*\/\s*(\d+))?$/;
const ROW_RE = /^(\S+)\s{2,}(.+)$/;
const SKIP_RE = /^(设置)\s+\//;

export type WidgetCardMeter = { name: string; remain: number; size: number };
export type WidgetCardRow = { label: string; value: string };
export type WidgetCardModel = {
  heading: string;
  metric: string | null;
  kicker: string | null;
  meters: WidgetCardMeter[];
  rows: WidgetCardRow[];
  notes: string[];
};

export function parseExtensionWidgetCard(
  lines: string[],
  fallbackTitle: string,
): WidgetCardModel {
  const cleaned = lines.map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
  let heading = fallbackTitle;
  let kicker: string | null = null;
  let start = 0;
  const first = cleaned[0];
  if (first?.includes(" · ")) {
    const parts = first.split(" · ");
    heading = parts[0]?.trim() || heading;
    kicker = parts.slice(1).join(" · ") || null;
    start = 1;
  } else if (first === heading) {
    start = 1;
  }

  const meters: WidgetCardMeter[] = [];
  const rows: WidgetCardRow[] = [];
  const notes: string[] = [];
  for (const line of cleaned.slice(start)) {
    const trimmed = line.trim();
    if (BAR_RE.test(trimmed) || SKIP_RE.test(trimmed)) continue;
    const meter = trimmed.match(METER_RE);
    if (meter) {
      const remain = Number(meter[2]);
      meters.push({
        name: meter[1].trim(),
        remain,
        size: meter[3] ? Number(meter[3]) : remain,
      });
      continue;
    }
    const row = trimmed.match(ROW_RE);
    if (row) {
      rows.push({ label: row[1], value: row[2].trim() });
      continue;
    }
    notes.push(trimmed);
  }

  const credit = rows.find((row) => row.label === "积分");
  const metric = credit?.value.replace(/^合计\s*/, "") ?? null;
  return {
    heading,
    metric,
    kicker,
    meters,
    rows: rows.filter((row) => row.label !== "积分"),
    notes,
  };
}

function meterTone(remain: number, size: number): string {
  if (size <= 0 || remain <= 0) return "var(--error)";
  if (remain / size <= 0.2) return "var(--warning)";
  return "var(--accent)";
}

function WidgetCardRowView({ row }: { row: WidgetCardRow }) {
  const parts = row.value.split(" | ").map((part) => part.trim()).filter(Boolean);
  const stacked = parts.length > 1 || row.value.length > 22;
  return (
    <div className={stacked ? "desktop-widget-card-row is-stack" : "desktop-widget-card-row"}>
      <span>{row.label}</span>
      <strong>
        {parts.length > 1 ? parts.map((part) => <span key={part}>{part}</span>) : row.value}
      </strong>
    </div>
  );
}

export function DesktopWidgetCards({ widgets }: { widgets: ExtensionWidgetItem[] }) {
  if (widgets.length === 0) return null;
  return widgets.map((widget) => {
    const card = parseExtensionWidgetCard(widget.lines, widget.title ?? widget.key);
    return (
      <aside
        key={widget.key}
        className="desktop-conversation-context desktop-widget-card"
        aria-label={card.heading}
        data-extension-widget-card={widget.key}
      >
        <div className="desktop-context-heading">
          <Puzzle size={14} strokeWidth={1.8} aria-hidden="true" />
          <span>{card.heading}</span>
          {card.metric ? <strong>{card.metric}</strong> : null}
        </div>
        {card.meters.map((meter) => {
          const percent = meter.size > 0 ? Math.min(100, (meter.remain / meter.size) * 100) : 0;
          return (
            <section key={meter.name} className="desktop-context-capacity">
              <div className="desktop-context-capacity-copy">
                <strong>{meter.remain} <small>/ {meter.size}</small></strong>
                <span>{meter.name}</span>
              </div>
              <div
                className="desktop-context-progress"
                style={{
                  "--context-percent": `${percent}%`,
                  "--context-tone": meterTone(meter.remain, meter.size),
                } as CSSProperties}
                aria-label={`${meter.name} ${meter.remain} / ${meter.size}`}
              >
                <span />
              </div>
            </section>
          );
        })}
        {card.meters.length === 0 && card.notes.length > 0 ? (
          <section className="desktop-context-capacity">
            <div className="desktop-widget-card-note">{card.notes.join("\n")}</div>
          </section>
        ) : null}
        {(card.kicker || card.rows.length > 0 || (card.meters.length > 0 && card.notes.length > 0)) ? (
          <div className="desktop-context-activity">
            {card.kicker ? <div className="desktop-widget-card-kicker">{card.kicker}</div> : null}
            {card.rows.map((row) => <WidgetCardRowView key={row.label} row={row} />)}
            {card.meters.length > 0 ? card.notes.map((note) => (
              <div key={note} className="desktop-widget-card-kicker">{note}</div>
            )) : null}
          </div>
        ) : null}
      </aside>
    );
  });
}

export function snapshotExtensionWidgetContents(
  widgets: ExtensionWidgetItem[],
): Map<string, string[]> {
  return new Map(widgets.map((widget) => [widget.key, [...widget.lines]]));
}

export function getUpdatedExtensionWidgetKeys(
  previous: ReadonlyMap<string, readonly string[]> | null,
  next: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (!previous) return [];
  return Array.from(next, ([key, lines]) => {
    const previousLines = previous.get(key);
    if (!previousLines || previousLines.length !== lines.length) {
      return previousLines ? key : null;
    }
    return lines.some((line, index) => line !== previousLines[index]) ? key : null;
  }).filter((key): key is string => key !== null);
}

function getDefaultExpandedWidgetKey(
  widgets: ExtensionWidgetItem[],
  expandFirst = false,
): string | null {
  if (expandFirst) return widgets.find((widget) => widget.lines.length > 0)?.key ?? null;
  return widgets.find((widget) => {
    const lineCount = widget.lines.length;
    return lineCount > 1 && lineCount <= DEFAULT_EXPANDED_WIDGET_LINES;
  })?.key ?? null;
}

export function getNextExpandedWidgetKey(
  currentKey: string | null,
  requestedKey: string,
): string | null {
  return currentKey === requestedKey ? null : requestedKey;
}

export function ExtensionWidgets({ widgets, expandFirst = false }: {
  widgets: ExtensionWidgetItem[];
  expandFirst?: boolean;
}) {
  const { t } = useI18n();
  const idPrefix = useId();
  const previousContentsRef = useRef<Map<string, string[]> | null>(null);
  const updateClearTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [expandedWidgetKey, setExpandedWidgetKey] = useState<string | null>(
    () => getDefaultExpandedWidgetKey(widgets, expandFirst),
  );
  const [updatingWidgetKeys, setUpdatingWidgetKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  useEffect(() => {
    const nextContents = snapshotExtensionWidgetContents(widgets);
    const updatedKeys = getUpdatedExtensionWidgetKeys(
      previousContentsRef.current,
      nextContents,
    );
    previousContentsRef.current = nextContents;

    for (const [key, timer] of updateClearTimersRef.current) {
      if (nextContents.has(key)) continue;
      clearTimeout(timer);
      updateClearTimersRef.current.delete(key);
    }

    setUpdatingWidgetKeys((current) => {
      const next = new Set(Array.from(current).filter((key) => nextContents.has(key)));
      for (const key of updatedKeys) next.add(key);
      if (
        next.size === current.size
        && Array.from(next).every((key) => current.has(key))
      ) return current;
      return next;
    });

    for (const key of updatedKeys) {
      const currentTimer = updateClearTimersRef.current.get(key);
      if (currentTimer) clearTimeout(currentTimer);
      updateClearTimersRef.current.set(key, setTimeout(() => {
        updateClearTimersRef.current.delete(key);
        setUpdatingWidgetKeys((current) => {
          if (!current.has(key)) return current;
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }, WIDGET_UPDATE_IDLE_MS));
    }
  }, [widgets]);

  useEffect(() => () => {
    for (const timer of updateClearTimersRef.current.values()) clearTimeout(timer);
    updateClearTimersRef.current.clear();
  }, []);

  if (widgets.length === 0) return null;

  const expandedWidget = widgets.find((widget) => (
    widget.key === expandedWidgetKey
  ));

  const toggleWidget = (widget: ExtensionWidgetItem) => {
    setExpandedWidgetKey((current) => getNextExpandedWidgetKey(current, widget.key));
  };

  return (
    <>
      {expandedWidget && (
        <div className="extension-widget-panels">
          {(() => {
            const widget = expandedWidget;
            const index = widgets.indexOf(widget);
            const triggerId = `${idPrefix}-trigger-${index}`;
            const panelId = `${idPrefix}-panel-${index}`;
            return (
              <section
                key={widget.key}
                id={panelId}
                className="extension-widget-panel"
                aria-labelledby={triggerId}
              >
                <div className="extension-widget-panel-heading">
                  <span>{widget.title ?? widget.key}</span>
                </div>
                <pre className="extension-widget-content">
                  {formatExtensionWidgetContent(widget.lines)}
                </pre>
              </section>
            );
          })()}
        </div>
      )}
      <div className="extension-widget-triggers" aria-label={t("chat.extensionWidgets")}>
        {widgets.map((widget, index) => {
          const expandable = widget.lines.length > 0;
          const expanded = expandable && widget.key === expandedWidget?.key;
          const updating = updatingWidgetKeys.has(widget.key);
          const lineCountLabel = t(
            widget.lines.length === 1 ? "chat.extensionWidgetLine" : "chat.extensionWidgetLines",
            { count: widget.lines.length },
          );
          const placementLabel = t(
            widget.placement === "belowEditor"
              ? "chat.extensionWidgetBelow"
              : "chat.extensionWidgetAbove",
          );
          const triggerId = `${idPrefix}-trigger-${index}`;
          const panelId = `${idPrefix}-panel-${index}`;
          const content = (
            <>
              <span className="extension-widget-update-pulse" aria-hidden="true" />
              <span className="extension-widget-placement" aria-hidden="true">
                <svg
                  className="extension-widget-placement-icon"
                  viewBox="0 0 8 6"
                  width="8"
                  height="6"
                  data-direction={widget.placement === "belowEditor" ? "down" : "up"}
                  focusable="false"
                >
                  <path
                    d={widget.placement === "belowEditor"
                      ? "M0 0h8L4 6z"
                      : "M4 0l4 6H0z"}
                  />
                </svg>
              </span>
              <span className="extension-widget-key">{widget.key}</span>
            </>
          );

          return expandable ? (
            <button
              key={widget.key}
              id={triggerId}
              type="button"
              className={`extension-widget-trigger${expanded ? " is-expanded" : ""}${updating ? " is-updating" : ""}`}
              aria-controls={panelId}
              aria-expanded={expanded}
              aria-label={`${placementLabel}: ${widget.key}, ${lineCountLabel}`}
              title={`${widget.key} - ${placementLabel} - ${expanded ? t("i18n.collapse") : t("i18n.expand")}`}
              onClick={() => toggleWidget(widget)}
            >
              {content}
            </button>
          ) : (
            <div
              key={widget.key}
              className={`extension-widget-trigger${updating ? " is-updating" : ""}`}
              aria-label={`${placementLabel}: ${widget.key}, ${lineCountLabel}`}
              title={`${widget.key} - ${placementLabel}`}
            >
              {content}
            </div>
          );
        })}
      </div>
    </>
  );
}
