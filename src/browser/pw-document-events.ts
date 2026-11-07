import type { EventEmitter } from "node:events";
import type { Frame, Page } from "playwright-core";
import { BrowserConfigurationError } from "./errors.js";

/** Playwright 1.58.2's public framenavigated omits the newDocument discriminator.
 * Keep this version-specific boundary narrow and validated by native tests. */
export function onMainDocumentChanged(page: Page, changed: () => void): () => void {
  const frame = page.mainFrame() as Frame & { _eventEmitter?: EventEmitter };
  const events = frame._eventEmitter;
  if (!events?.on || !events.off) {
    throw new BrowserConfigurationError("Playwright document navigation events are unavailable.");
  }
  const listener = (event: { newDocument?: unknown; error?: string }) => {
    if (event.newDocument && !event.error) {
      changed();
    }
  };
  events.on("navigated", listener);
  return () => {
    events.off("navigated", listener);
  };
}
