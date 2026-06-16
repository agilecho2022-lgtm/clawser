import {
  clearBrowserActivity,
  readBrowserActivity,
  type BrowserActivityKind,
} from "./pw-activity-log.js";
import type {
  BrowserConsoleMessage,
  BrowserNetworkRequest,
  BrowserPageError,
} from "./pw-session.js";
import { ensurePageState, getPageForTargetId } from "./pw-session.js";

function activityTarget(opts: { cdpUrl: string; targetId?: string }) {
  const targetId = opts.targetId?.trim() || "";
  return targetId ? { cdpUrl: opts.cdpUrl, targetId } : null;
}

function readPersisted<T>(kind: BrowserActivityKind, opts: { cdpUrl: string; targetId?: string }) {
  const target = activityTarget(opts);
  return target ? readBrowserActivity<T>(kind, target) : [];
}

function clearPersisted(kind: BrowserActivityKind, opts: { cdpUrl: string; targetId?: string }) {
  const target = activityTarget(opts);
  if (target) {
    clearBrowserActivity(kind, target);
  }
}

function dedupeByJson<T>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(item);
  }
  return out;
}

function mergeRequests(items: BrowserNetworkRequest[]): BrowserNetworkRequest[] {
  const merged = new Map<string, BrowserNetworkRequest>();
  for (const item of items) {
    const prev = merged.get(item.id);
    merged.set(item.id, prev ? { ...prev, ...item } : item);
  }
  return [...merged.values()];
}

export async function getPageErrorsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  clear?: boolean;
}): Promise<{ errors: BrowserPageError[] }> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const errors = dedupeByJson([...readPersisted<BrowserPageError>("error", opts), ...state.errors]);
  if (opts.clear) {
    state.errors = [];
    clearPersisted("error", opts);
  }
  return { errors };
}

export async function getNetworkRequestsViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  filter?: string;
  clear?: boolean;
}): Promise<{ requests: BrowserNetworkRequest[] }> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const raw = mergeRequests([
    ...readPersisted<BrowserNetworkRequest>("request", opts),
    ...state.requests,
  ]);
  const filter = typeof opts.filter === "string" ? opts.filter.trim() : "";
  const requests = filter ? raw.filter((r) => r.url.includes(filter)) : raw;
  if (opts.clear) {
    state.requests = [];
    state.requestIds = new WeakMap();
    clearPersisted("request", opts);
  }
  return { requests };
}

function consolePriority(level: string) {
  switch (level) {
    case "error":
      return 3;
    case "warn":
    case "warning":
      return 2;
    case "info":
    case "log":
      return 1;
    case "debug":
      return 0;
    default:
      return 1;
  }
}

export async function getConsoleMessagesViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  level?: string;
}): Promise<BrowserConsoleMessage[]> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const messages = dedupeByJson([
    ...readPersisted<BrowserConsoleMessage>("console", opts),
    ...state.console,
  ]);
  if (!opts.level) {
    return messages;
  }
  const min = consolePriority(opts.level);
  return messages.filter((msg) => consolePriority(msg.type) >= min);
}
