import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const chat = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("desktop workspace keeps the transcript free of a right context gutter", () => {
  assert.match(shell, /className="skip-to-chat"/);
  assert.match(shell, /<nav[\s\S]*id="session-sidebar"/);
  assert.match(shell, /<main id="conversation" className="app-center-column"/);
  assert.doesNotMatch(shell, /\bDesktopConversationContext\b/);
  assert.doesNotMatch(chat, /desktop-workspace-context/);
  assert.doesNotMatch(chat, /\bdesktopAside\b/);
  assert.match(chat, /DESKTOP_TRANSCRIPT_WIDTH = 760/);
  assert.doesNotMatch(css, /desktop-workspace-context/);
  assert.doesNotMatch(css, /@container chat-center/);
});

test("minimap is a direct workspace sibling after the chat column", () => {
  const main = chat.indexOf('className="chat-workspace-main"');
  const mainClose = chat.indexOf('\n        </div>\n        {isMobile ? null', main);
  const minimap = chat.indexOf("<ChatMinimap", mainClose);

  assert.ok(main >= 0 && mainClose > main && minimap > mainClose);
});
