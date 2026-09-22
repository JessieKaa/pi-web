"use client";

import type { ExtensionStatusItem, ExtensionWidgetItem } from "@/lib/types";
import { ExtensionWidgets } from "./ExtensionWidgets";

export function ExtensionStatusBar({
  widgets = [],
  expandFirst = false,
}: {
  statuses: ExtensionStatusItem[];
  widgets?: ExtensionWidgetItem[];
  expandFirst?: boolean;
}) {
  if (widgets.length === 0) return null;

  return (
    <div className="extension-status-shelf has-widgets">
      <ExtensionWidgets widgets={widgets} expandFirst={expandFirst} />
    </div>
  );
}
