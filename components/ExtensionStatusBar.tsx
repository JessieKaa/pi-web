"use client";

import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import { ExtensionWidgets } from "./ExtensionWidgets";

export function ExtensionStatusBar({
  widgets = [],
  gutterDuplicate = false,
  expandFirst = false,
}: {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
  gutterDuplicate?: boolean;
  expandFirst?: boolean;
}) {
  if (widgets.length === 0) return null;

  return (
    <div className={`extension-status-shelf has-widgets${gutterDuplicate ? " has-gutter-dup" : ""}`}>
      <ExtensionWidgets widgets={widgets} expandFirst={expandFirst} />
    </div>
  );
}
