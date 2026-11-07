import { randomUUID } from "node:crypto";
import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Frame,
  Locator,
  Page,
  Request,
  Response,
} from "playwright-core";
import { chromium } from "playwright-core";
import { formatErrorMessage } from "../infra/errors.js";
import type { SsrFPolicy } from "../infra/net/ssrf.js";
import { withNoProxyForCdpUrl } from "./cdp-proxy-bypass.js";
import {
  appendCdpPath,
  fetchJson,
  getHeadersWithAuth,
  normalizeCdpHttpBaseForJsonEndpoints,
  withCdpSocket,
} from "./cdp.helpers.js";
import type { AriaSnapshotNode } from "./cdp.js";
import { normalizeCdpWsUrl } from "./cdp.js";
import { getChromeWebSocketUrl } from "./chrome.js";
import {
  BrowserSnapshotStaleError,
  BrowserTabNotFoundError,
  BrowserTargetUnavailableError,
} from "./errors.js";
import {
  assertBrowserNavigationAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  assertBrowserNavigationResultAllowed,
  withBrowserNavigationPolicy,
} from "./navigation-guard.js";
import { appendBrowserActivity } from "./pw-activity-log.js";
import { bindSnapshotLocator } from "./pw-ref-locator.js";
import {
  forgetExtensionRelayCdpEndpoint,
  isExtensionRelayCdpEndpoint,
  withPageScopedCdpClient,
} from "./pw-session.page-cdp.js";
import { findExtensionPageByNativeTarget } from "./pw-target-proof.js";
import { assertTargetInventory } from "./target-inventory.js";

export type BrowserConsoleMessage = {
  type: string;
  text: string;
  timestamp: string;
  location?: { url?: string; lineNumber?: number; columnNumber?: number };
};

export type BrowserPageError = {
  message: string;
  name?: string;
  stack?: string;
  timestamp: string;
};

export type BrowserNetworkRequest = {
  id: string;
  timestamp: string;
  method: string;
  url: string;
  resourceType?: string;
  status?: number;
  ok?: boolean;
  failureText?: string;
};

type SnapshotForAIResult = { full: string; incremental?: string };
type SnapshotForAIOptions = { timeout?: number; track?: string };

export type WithSnapshotForAI = {
  _snapshotForAI?: (options?: SnapshotForAIOptions) => Promise<SnapshotForAIResult>;
};

type TargetInfoResponse = {
  targetInfo?: {
    targetId?: string;
  };
};

type ConnectedBrowser = {
  browser: Browser;
  cdpUrl: string;
  onDisconnected?: () => void;
};

type PageState = {
  snapshotRevision: number;
  frameRevisions: WeakMap<Frame, number>;
  rawAriaSnapshotRevision?: number;
  console: BrowserConsoleMessage[];
  errors: BrowserPageError[];
  requests: BrowserNetworkRequest[];
  requestIds: WeakMap<Request, string>;
  nextRequestId: number;
  activityTarget?: { cdpUrl: string; targetId: string };
  requestIdPrefix: string;
  armIdUpload: number;
  armIdDialog: number;
  armIdDownload: number;
  /**
   * Role-based refs from the last role snapshot (e.g. e1/e2).
   * Mode "role" refs are generated from ariaSnapshot and resolved via getByRole.
   * Mode "aria" refs are Playwright aria-ref ids and resolved via `aria-ref=...`.
   */
  roleRefs?: Record<string, { role: string; name?: string; nth?: number }>;
  roleRefsMode?: "role" | "aria";
  roleRefsFrameSelector?: string;
  roleRefsFrame?: Frame;
  roleRefsTargetKey?: string;
  roleRefsInvalidated?: boolean;
};

type RoleRefs = NonNullable<PageState["roleRefs"]>;
type RoleRefsCacheEntry = {
  refs: RoleRefs;
  frameSelector?: string;
  mode?: NonNullable<PageState["roleRefsMode"]>;
  page?: WeakRef<Page>;
  invalidated?: true;
};
type AriaRefsCacheEntry = {
  nodes: Array<Pick<AriaSnapshotNode, "ref" | "role" | "depth">>;
  page?: WeakRef<Page>;
  invalidated?: true;
};

type ContextState = {
  traceActive: boolean;
};

const pageStates = new WeakMap<Page, PageState>();
const contextStates = new WeakMap<BrowserContext, ContextState>();
const observedContexts = new WeakSet<BrowserContext>();
const observedPages = new WeakSet<Page>();

// Best-effort cache to make role refs stable even if Playwright returns a different Page object
// for the same CDP target across requests.
const roleRefsByTarget = new Map<string, RoleRefsCacheEntry>();
const ariaRefsByTarget = new Map<string, AriaRefsCacheEntry>();
const MAX_ROLE_REFS_CACHE = 50;

const MAX_CONSOLE_MESSAGES = 500;
const MAX_PAGE_ERRORS = 200;
const MAX_NETWORK_REQUESTS = 500;

const cachedByCdpUrl = new Map<string, ConnectedBrowser>();
const connectingByCdpUrl = new Map<string, Promise<ConnectedBrowser>>();

function normalizeCdpUrl(raw: string) {
  return raw.replace(/\/$/, "");
}

function findNetworkRequestById(state: PageState, id: string): BrowserNetworkRequest | undefined {
  for (let i = state.requests.length - 1; i >= 0; i -= 1) {
    const candidate = state.requests[i];
    if (candidate && candidate.id === id) {
      return candidate;
    }
  }
  return undefined;
}

function roleRefsKey(cdpUrl: string, targetId: string) {
  return `${normalizeCdpUrl(cdpUrl)}::${targetId}`;
}

const ACTIONABLE_ARIA_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

function isActionableAriaRole(role: string | undefined): boolean {
  return ACTIONABLE_ARIA_ROLES.has(
    String(role ?? "")
      .trim()
      .toLowerCase(),
  );
}

function resolveActionableAriaRefFromNodes(
  nodes: AriaRefsCacheEntry["nodes"],
  ref: string,
): string {
  const index = nodes.findIndex((node) => node.ref === ref);
  const node = index >= 0 ? nodes[index] : undefined;
  if (!node) {
    return ref;
  }
  if (isActionableAriaRole(node.role)) {
    return ref;
  }

  let depth = node.depth;
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = nodes[i];
    if (!candidate || candidate.depth >= depth) {
      continue;
    }
    depth = candidate.depth;
    if (isActionableAriaRole(candidate.role)) {
      return candidate.ref;
    }
  }
  return ref;
}

export function rememberAriaRefsForTarget(opts: {
  cdpUrl: string;
  targetId: string;
  nodes: AriaSnapshotNode[];
  page?: Page;
}): void {
  const targetId = opts.targetId.trim();
  if (!targetId || opts.nodes.length === 0) {
    return;
  }
  ariaRefsByTarget.set(roleRefsKey(opts.cdpUrl, targetId), {
    ...(opts.page ? { page: new WeakRef(opts.page) } : {}),
    nodes: opts.nodes.map((node) => ({
      ref: node.ref,
      role: node.role,
      depth: node.depth,
    })),
  });
  while (ariaRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
    const first = ariaRefsByTarget.keys().next();
    if (first.done) {
      break;
    }
    ariaRefsByTarget.delete(first.value);
  }
}

function resolveCachedAriaRefForPage(page: Page, ref: string): string {
  const target = pageStates.get(page)?.activityTarget;
  if (!target) {
    return ref;
  }
  const cached = ariaRefsByTarget.get(roleRefsKey(target.cdpUrl, target.targetId));
  if (!cached || cached.invalidated) {
    return ref;
  }
  return resolveActionableAriaRefFromNodes(cached.nodes, ref);
}

export function rememberRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId: string;
  refs: RoleRefs;
  frameSelector?: string;
  mode?: NonNullable<PageState["roleRefsMode"]>;
  page?: Page;
}): void {
  const targetId = opts.targetId.trim();
  if (!targetId) {
    return;
  }
  roleRefsByTarget.set(roleRefsKey(opts.cdpUrl, targetId), {
    refs: opts.refs,
    ...(opts.frameSelector ? { frameSelector: opts.frameSelector } : {}),
    ...(opts.mode ? { mode: opts.mode } : {}),
    ...(opts.page ? { page: new WeakRef(opts.page) } : {}),
  });
  while (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
    const first = roleRefsByTarget.keys().next();
    if (first.done) {
      break;
    }
    roleRefsByTarget.delete(first.value);
  }
}

export function storeRoleRefsForTarget(opts: {
  page: Page;
  cdpUrl: string;
  targetId?: string;
  refs: RoleRefs;
  frameSelector?: string;
  frame?: Frame;
  mode: NonNullable<PageState["roleRefsMode"]>;
}): void {
  const state = ensurePageState(opts.page);
  state.roleRefs = opts.refs;
  state.roleRefsFrameSelector = opts.frameSelector;
  state.roleRefsFrame = opts.frame;
  state.roleRefsMode = opts.mode;
  state.roleRefsInvalidated = false;
  if (!opts.targetId?.trim()) {
    return;
  }
  state.roleRefsTargetKey = roleRefsKey(opts.cdpUrl, opts.targetId);
  rememberRoleRefsForTarget({
    cdpUrl: opts.cdpUrl,
    targetId: opts.targetId,
    refs: opts.refs,
    frameSelector: opts.frameSelector,
    mode: opts.mode,
    page: opts.page,
  });
}

export function restoreRoleRefsForTarget(opts: {
  cdpUrl: string;
  targetId?: string;
  page: Page;
}): void {
  const targetId = opts.targetId?.trim() || "";
  if (!targetId) {
    return;
  }
  const key = roleRefsKey(opts.cdpUrl, targetId);
  const cached = roleRefsByTarget.get(key);
  const state = ensurePageState(opts.page);
  state.roleRefsTargetKey = key;
  if (!cached) {
    return;
  }
  if (
    state.roleRefsInvalidated ||
    cached.invalidated ||
    (cached.page && cached.page.deref() !== opts.page) ||
    (cached.frameSelector && cached.page?.deref() !== opts.page)
  ) {
    state.roleRefsInvalidated = true;
    state.roleRefs = undefined;
    return;
  }
  if (state.roleRefs) {
    return;
  }
  state.roleRefs = cached.refs;
  state.roleRefsFrameSelector = cached.frameSelector;
  state.roleRefsMode = cached.mode;
}

export function assertSnapshotRefsCurrent(page: Page, ref?: string): void {
  const state = pageStates.get(page);
  const rawAx = /^(?:@|ref=)?ax\d+$/i.test(ref ?? "");
  if (rawAx && state) {
    const key =
      state.roleRefsTargetKey ??
      (state.activityTarget
        ? roleRefsKey(state.activityTarget.cdpUrl, state.activityTarget.targetId)
        : undefined);
    const cache = key ? ariaRefsByTarget.get(key) : undefined;
    if (
      (state.rawAriaSnapshotRevision !== undefined &&
        state.rawAriaSnapshotRevision !== state.snapshotRevision) ||
      cache?.invalidated ||
      (cache?.page && cache.page.deref() !== page)
    ) {
      throw new BrowserSnapshotStaleError();
    }
  }
  if (
    state?.roleRefsInvalidated &&
    !(rawAx && state.rawAriaSnapshotRevision === state.snapshotRevision)
  ) {
    throw new BrowserSnapshotStaleError();
  }
}

function invalidateRawAriaRefs(page: Page, state: PageState): void {
  const key =
    state.roleRefsTargetKey ??
    (state.activityTarget
      ? roleRefsKey(state.activityTarget.cdpUrl, state.activityTarget.targetId)
      : undefined);
  const cached = key ? ariaRefsByTarget.get(key) : undefined;
  if (cached && (!cached.page || cached.page.deref() === page)) {
    cached.invalidated = true;
  }
}

function invalidateSnapshotRefs(page: Page, state: PageState): void {
  const key =
    state.roleRefsTargetKey ??
    (state.activityTarget
      ? roleRefsKey(state.activityTarget.cdpUrl, state.activityTarget.targetId)
      : undefined);
  const cached = key ? roleRefsByTarget.get(key) : undefined;
  if (!state.roleRefs && !state.roleRefsMode && !state.roleRefsInvalidated && !cached) {
    return;
  }
  state.roleRefsInvalidated = true;
  state.roleRefs = undefined;
  state.roleRefsMode = undefined;
  state.roleRefsFrame = undefined;
  state.roleRefsFrameSelector = undefined;
  if (key) {
    // A delayed event from a retired Page must not revoke a successor's snapshot.
    if (!cached?.page || cached.page.deref() === page) {
      roleRefsByTarget.set(key, { refs: {}, invalidated: true, page: new WeakRef(page) });
      invalidateRawAriaRefs(page, state);
      while (roleRefsByTarget.size > MAX_ROLE_REFS_CACHE) {
        const oldest = roleRefsByTarget.keys().next();
        if (oldest.done) {
          break;
        }
        roleRefsByTarget.delete(oldest.value);
      }
    }
  }
}

export function ensurePageState(page: Page): PageState {
  const existing = pageStates.get(page);
  if (existing) {
    return existing;
  }

  const state: PageState = {
    snapshotRevision: 0,
    frameRevisions: new WeakMap(),
    console: [],
    errors: [],
    requests: [],
    requestIds: new WeakMap(),
    nextRequestId: 0,
    requestIdPrefix: randomUUID(),
    armIdUpload: 0,
    armIdDialog: 0,
    armIdDownload: 0,
  };
  pageStates.set(page, state);

  if (!observedPages.has(page)) {
    observedPages.add(page);
    page.on("console", (msg: ConsoleMessage) => {
      const entry: BrowserConsoleMessage = {
        type: msg.type(),
        text: msg.text(),
        timestamp: new Date().toISOString(),
        location: msg.location(),
      };
      state.console.push(entry);
      if (state.console.length > MAX_CONSOLE_MESSAGES) {
        state.console.shift();
      }
      if (state.activityTarget) {
        appendBrowserActivity("console", state.activityTarget, entry);
      }
    });
    page.on("pageerror", (err: Error) => {
      const entry = {
        message: err?.message ? String(err.message) : String(err),
        name: err?.name ? String(err.name) : undefined,
        stack: err?.stack ? String(err.stack) : undefined,
        timestamp: new Date().toISOString(),
      };
      state.errors.push(entry);
      if (state.errors.length > MAX_PAGE_ERRORS) {
        state.errors.shift();
      }
      if (state.activityTarget) {
        appendBrowserActivity("error", state.activityTarget, entry);
      }
    });
    page.on("request", (req: Request) => {
      state.nextRequestId += 1;
      const id = `${state.requestIdPrefix}-r${state.nextRequestId}`;
      state.requestIds.set(req, id);
      const entry = {
        id,
        timestamp: new Date().toISOString(),
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
      };
      state.requests.push(entry);
      if (state.requests.length > MAX_NETWORK_REQUESTS) {
        state.requests.shift();
      }
      if (state.activityTarget) {
        appendBrowserActivity("request", state.activityTarget, entry);
      }
    });
    page.on("response", (resp: Response) => {
      const req = resp.request();
      const id = state.requestIds.get(req);
      if (!id) {
        return;
      }
      const rec = findNetworkRequestById(state, id);
      if (!rec) {
        return;
      }
      rec.status = resp.status();
      rec.ok = resp.ok();
      if (state.activityTarget) {
        appendBrowserActivity("request", state.activityTarget, rec);
      }
    });
    page.on("requestfailed", (req: Request) => {
      const id = state.requestIds.get(req);
      if (!id) {
        return;
      }
      const rec = findNetworkRequestById(state, id);
      if (!rec) {
        return;
      }
      rec.failureText = req.failure()?.errorText;
      rec.ok = false;
      if (state.activityTarget) {
        appendBrowserActivity("request", state.activityTarget, rec);
      }
    });
    const invalidateFrame = (frame: Frame, navigated: boolean) => {
      state.snapshotRevision++;
      state.frameRevisions.set(frame, (state.frameRevisions.get(frame) ?? 0) + 1);
      invalidateRawAriaRefs(page, state);
      if (
        (navigated && frame === page.mainFrame()) ||
        state.roleRefsMode === "aria" ||
        (state.roleRefsFrame && frame === state.roleRefsFrame) ||
        (state.roleRefsFrameSelector && !state.roleRefsFrame)
      ) {
        invalidateSnapshotRefs(page, state);
      }
    };
    page.on("framenavigated", (frame) => invalidateFrame(frame, true));
    page.on("framedetached", (frame) => invalidateFrame(frame, false));
    page.on("close", () => {
      state.snapshotRevision++;
      invalidateRawAriaRefs(page, state);
      invalidateSnapshotRefs(page, state);
      pageStates.delete(page);
      observedPages.delete(page);
    });
  }

  return state;
}

function bindPageActivityTarget(page: Page, opts: { cdpUrl: string; targetId?: string }): void {
  const targetId = opts.targetId?.trim() || "";
  if (!targetId) {
    return;
  }
  const state = ensurePageState(page);
  state.activityTarget = {
    cdpUrl: opts.cdpUrl.trim().replace(/\/$/, ""),
    targetId,
  };
}

function observeContext(context: BrowserContext) {
  if (observedContexts.has(context)) {
    return;
  }
  observedContexts.add(context);
  ensureContextState(context);

  for (const page of context.pages()) {
    ensurePageState(page);
  }
  context.on("page", (page) => ensurePageState(page));
}

export function ensureContextState(context: BrowserContext): ContextState {
  const existing = contextStates.get(context);
  if (existing) {
    return existing;
  }
  const state: ContextState = { traceActive: false };
  contextStates.set(context, state);
  return state;
}

function observeBrowser(browser: Browser) {
  for (const context of browser.contexts()) {
    observeContext(context);
  }
}

async function connectBrowser(cdpUrl: string): Promise<ConnectedBrowser> {
  const normalized = normalizeCdpUrl(cdpUrl);
  const cached = cachedByCdpUrl.get(normalized);
  if (cached) {
    return cached;
  }
  const connecting = connectingByCdpUrl.get(normalized);
  if (connecting) {
    return await connecting;
  }

  const connectWithRetry = async (): Promise<ConnectedBrowser> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const timeout = 5000 + attempt * 2000;
        const wsUrl = await getChromeWebSocketUrl(normalized, timeout).catch(() => null);
        const endpoint = wsUrl ?? normalized;
        const headers = getHeadersWithAuth(endpoint);
        // Bypass proxy for loopback CDP connections (#31219)
        const browser = await withNoProxyForCdpUrl(endpoint, () =>
          chromium.connectOverCDP(endpoint, { timeout, headers }),
        );
        const onDisconnected = () => {
          const current = cachedByCdpUrl.get(normalized);
          if (current?.browser === browser) {
            cachedByCdpUrl.delete(normalized);
            forgetExtensionRelayCdpEndpoint(normalized);
          }
        };
        const connected: ConnectedBrowser = { browser, cdpUrl: normalized, onDisconnected };
        cachedByCdpUrl.set(normalized, connected);
        browser.on("disconnected", onDisconnected);
        observeBrowser(browser);
        return connected;
      } catch (err) {
        lastErr = err;
        // Don't retry rate-limit errors; retrying worsens the 429.
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes("rate limit")) {
          break;
        }
        const delay = 250 + attempt * 250;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    if (lastErr instanceof Error) {
      throw lastErr;
    }
    const message = lastErr ? formatErrorMessage(lastErr) : "CDP connect failed";
    throw new Error(message);
  };

  const pending = connectWithRetry().finally(() => {
    connectingByCdpUrl.delete(normalized);
  });
  connectingByCdpUrl.set(normalized, pending);

  return await pending;
}

async function getAllPages(browser: Browser): Promise<Page[]> {
  const contexts = browser.contexts();
  const pages = contexts.flatMap((c) => c.pages());
  return pages;
}

async function pageTargetId(page: Page): Promise<string | null> {
  const session = await page.context().newCDPSession(page);
  try {
    const info = (await session.send("Target.getTargetInfo")) as TargetInfoResponse;
    const targetId = String(info?.targetInfo?.targetId ?? "").trim();
    return targetId || null;
  } finally {
    await session.detach().catch(() => {});
  }
}

async function findPageByTargetId(
  browser: Browser,
  targetId: string,
  cdpUrl?: string,
): Promise<Page | null> {
  const pages = await getAllPages(browser);
  const isExtensionRelay = cdpUrl
    ? await isExtensionRelayCdpEndpoint(cdpUrl).catch(() => false)
    : false;
  if (cdpUrl && isExtensionRelay) {
    return await findExtensionPageByNativeTarget(browser, cdpUrl, targetId);
  }

  for (const page of pages) {
    let tid: string | null = null;
    try {
      tid = await pageTargetId(page);
    } catch {
      tid = null;
    }
    if (tid && tid === targetId) {
      return page;
    }
  }
  if (cdpUrl) {
    try {
      const targets = await fetchJson<Array<{ id: string }>>(
        appendCdpPath(normalizeCdpHttpBaseForJsonEndpoints(cdpUrl), "/json/list"),
        2000,
      );
      assertTargetInventory(targets);
      if (targets.some((target) => target.id === targetId)) {
        throw new BrowserTargetUnavailableError();
      }
    } catch (error) {
      if (error instanceof BrowserTargetUnavailableError) {
        throw error;
      }
      throw new BrowserTargetUnavailableError(
        "Target inventory is unavailable; page absence is not established.",
      );
    }
  }
  return null;
}

async function resolvePageByTargetIdOrThrow(opts: {
  cdpUrl: string;
  targetId: string;
}): Promise<Page> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const page = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
  if (!page) {
    throw new BrowserTabNotFoundError();
  }
  return page;
}

export async function getPageForTargetId(opts: {
  cdpUrl: string;
  targetId?: string;
}): Promise<Page> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const pages = await getAllPages(browser);
  if (opts.targetId) {
    const found = await findPageByTargetId(browser, opts.targetId, opts.cdpUrl);
    if (!found) {
      throw new BrowserTabNotFoundError();
    }
    bindPageActivityTarget(found, opts);
    return found;
  }
  if (!pages.length) {
    throw new Error("No pages available in the connected browser.");
  }
  const first = pages[0];
  return first;
}

function bindRefLocator(page: Page, ref: string, locator: Locator): Locator {
  const state = ensurePageState(page);
  const main = page.mainFrame();
  const frame = state.roleRefsFrame ?? main;
  const mainRevision = state.frameRevisions.get(main) ?? 0;
  const frameRevision = state.frameRevisions.get(frame) ?? 0;
  const wide = state.roleRefsMode === "aria" || /^(?:@|ref=)?ax\d+$/i.test(ref);
  const revision = state.snapshotRevision;
  return bindSnapshotLocator(locator, () => {
    assertSnapshotRefsCurrent(page, ref);
    if (
      (state.frameRevisions.get(main) ?? 0) !== mainRevision ||
      (state.frameRevisions.get(frame) ?? 0) !== frameRevision ||
      (wide && state.snapshotRevision !== revision)
    ) {
      throw new BrowserSnapshotStaleError();
    }
  });
}

export function refLocator(page: Page, ref: string): Locator {
  assertSnapshotRefsCurrent(page, ref);
  const normalized = ref.startsWith("@")
    ? ref.slice(1)
    : ref.startsWith("ref=")
      ? ref.slice(4)
      : ref;

  if (/^e\d+$/.test(normalized)) {
    const state = pageStates.get(page);
    const resolved = resolveCachedAriaRefForPage(page, normalized);
    if (state?.roleRefsMode === "aria") {
      const scope = state.roleRefsFrameSelector
        ? page.frameLocator(state.roleRefsFrameSelector)
        : page;
      return bindRefLocator(page, ref, scope.locator(`aria-ref=${resolved}`));
    }
    const info = state?.roleRefs?.[resolved];
    if (!info) {
      throw new Error(
        `Unknown ref "${normalized}". Run a new snapshot and use a ref from that snapshot.`,
      );
    }
    const scope = state?.roleRefsFrameSelector
      ? page.frameLocator(state.roleRefsFrameSelector)
      : page;
    const locAny = scope as unknown as {
      getByRole: (
        role: never,
        opts?: { name?: string; exact?: boolean },
      ) => ReturnType<Page["getByRole"]>;
    };
    const locator = info.name
      ? locAny.getByRole(info.role as never, { name: info.name, exact: true })
      : locAny.getByRole(info.role as never);
    return bindRefLocator(page, ref, info.nth !== undefined ? locator.nth(info.nth) : locator);
  }

  const resolved = /^ax\d+$/i.test(normalized)
    ? resolveCachedAriaRefForPage(page, normalized)
    : normalized;
  return bindRefLocator(page, ref, page.locator(`aria-ref=${resolved}`));
}

export async function closePlaywrightBrowserConnection(opts?: { cdpUrl?: string }): Promise<void> {
  const normalized = opts?.cdpUrl ? normalizeCdpUrl(opts.cdpUrl) : null;
  forgetExtensionRelayCdpEndpoint(normalized ?? undefined);

  if (normalized) {
    const cur = cachedByCdpUrl.get(normalized);
    cachedByCdpUrl.delete(normalized);
    connectingByCdpUrl.delete(normalized);
    if (!cur) {
      return;
    }
    if (cur.onDisconnected && typeof cur.browser.off === "function") {
      cur.browser.off("disconnected", cur.onDisconnected);
    }
    await cur.browser.close().catch(() => {});
    return;
  }

  const connections = Array.from(cachedByCdpUrl.values());
  cachedByCdpUrl.clear();
  connectingByCdpUrl.clear();
  for (const cur of connections) {
    if (cur.onDisconnected && typeof cur.browser.off === "function") {
      cur.browser.off("disconnected", cur.onDisconnected);
    }
    await cur.browser.close().catch(() => {});
  }
}

function cdpSocketNeedsAttach(wsUrl: string): boolean {
  try {
    const pathname = new URL(wsUrl).pathname;
    return (
      pathname === "/cdp" || pathname.endsWith("/cdp") || pathname.includes("/devtools/browser/")
    );
  } catch {
    return false;
  }
}

async function tryTerminateExecutionViaCdp(opts: {
  cdpUrl: string;
  targetId: string;
}): Promise<void> {
  const cdpHttpBase = normalizeCdpHttpBaseForJsonEndpoints(opts.cdpUrl);
  const listUrl = appendCdpPath(cdpHttpBase, "/json/list");

  const pages = await fetchJson<
    Array<{
      id?: string;
      webSocketDebuggerUrl?: string;
    }>
  >(listUrl, 2000).catch(() => null);
  if (!pages || pages.length === 0) {
    return;
  }

  const target = pages.find((p) => String(p.id ?? "").trim() === opts.targetId);
  const wsUrlRaw = String(target?.webSocketDebuggerUrl ?? "").trim();
  if (!wsUrlRaw) {
    return;
  }
  const wsUrl = normalizeCdpWsUrl(wsUrlRaw, cdpHttpBase);
  const needsAttach = cdpSocketNeedsAttach(wsUrl);

  const runWithTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("CDP command timed out")), ms);
    });
    try {
      return await Promise.race([work, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  };

  await withCdpSocket(
    wsUrl,
    async (send) => {
      let sessionId: string | undefined;
      try {
        if (needsAttach) {
          const attached = (await runWithTimeout(
            send("Target.attachToTarget", { targetId: opts.targetId, flatten: true }),
            1500,
          )) as { sessionId?: unknown };
          if (typeof attached?.sessionId === "string" && attached.sessionId.trim()) {
            sessionId = attached.sessionId;
          }
        }
        await runWithTimeout(send("Runtime.terminateExecution", undefined, sessionId), 1500);
        if (sessionId) {
          // Best-effort cleanup; not required for termination to take effect.
          void send("Target.detachFromTarget", { sessionId }).catch(() => {});
        }
      } catch {
        // Best-effort; ignore
      }
    },
    { handshakeTimeoutMs: 2000 },
  ).catch(() => {});
}

/**
 * Best-effort cancellation for stuck page operations.
 *
 * Playwright serializes CDP commands per page; a long-running or stuck operation (notably evaluate)
 * can block all subsequent commands. We cannot safely "cancel" an individual command, and we do
 * not want to close the actual Chromium tab. Instead, we disconnect Playwright's CDP connection
 * so in-flight commands fail fast and the next request reconnects transparently.
 *
 * IMPORTANT: We CANNOT call Connection.close() because Playwright shares a single Connection
 * across all objects (BrowserType, Browser, etc.). Closing it corrupts the entire Playwright
 * instance, preventing reconnection.
 *
 * Instead we:
 * 1. Null out `cached` so the next call triggers a fresh connectOverCDP
 * 2. Fire-and-forget browser.close() — it may hang but won't block us
 * 3. The next connectBrowser() creates a completely new CDP WebSocket connection
 *
 * The old browser.close() eventually resolves when the in-browser evaluate timeout fires,
 * or the old connection gets GC'd. Either way, it doesn't affect the fresh connection.
 */
export async function forceDisconnectPlaywrightForTarget(opts: {
  cdpUrl: string;
  targetId?: string;
  reason?: string;
}): Promise<void> {
  const normalized = normalizeCdpUrl(opts.cdpUrl);
  forgetExtensionRelayCdpEndpoint(normalized);
  const cur = cachedByCdpUrl.get(normalized);
  if (!cur) {
    return;
  }
  cachedByCdpUrl.delete(normalized);
  // Also clear the per-url in-flight connect so the next call does a fresh connectOverCDP
  // rather than awaiting a stale promise.
  connectingByCdpUrl.delete(normalized);
  // Remove the "disconnected" listener to prevent the old browser's teardown
  // from racing with a fresh connection and nulling the new cached entry.
  if (cur.onDisconnected && typeof cur.browser.off === "function") {
    cur.browser.off("disconnected", cur.onDisconnected);
  }

  // Best-effort: kill any stuck JS to unblock the target's execution context before we
  // disconnect Playwright's CDP connection.
  const targetId = opts.targetId?.trim() || "";
  if (targetId) {
    await tryTerminateExecutionViaCdp({ cdpUrl: normalized, targetId }).catch(() => {});
  }

  // Fire-and-forget: don't await because browser.close() may hang on the stuck CDP pipe.
  cur.browser.close().catch(() => {});
}

/**
 * List all pages/tabs from the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/list is ephemeral.
 */
export async function listPagesViaPlaywright(opts: { cdpUrl: string }): Promise<
  Array<{
    targetId: string;
    title: string;
    url: string;
    type: string;
  }>
> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const pages = await getAllPages(browser);
  const results: Array<{
    targetId: string;
    title: string;
    url: string;
    type: string;
  }> = [];

  for (const page of pages) {
    const tid = await pageTargetId(page).catch(() => null);
    if (tid) {
      results.push({
        targetId: tid,
        title: await page.title().catch(() => ""),
        url: page.url(),
        type: "page",
      });
    }
  }
  return results;
}

/**
 * Create a new page/tab using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/new is ephemeral.
 * Returns the new page's targetId and metadata.
 */
export async function createPageViaPlaywright(opts: {
  cdpUrl: string;
  url: string;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{
  targetId: string;
  title: string;
  url: string;
  type: string;
}> {
  const { browser } = await connectBrowser(opts.cdpUrl);
  const context = browser.contexts()[0] ?? (await browser.newContext());
  ensureContextState(context);

  const page = await context.newPage();
  ensurePageState(page);

  // Navigate to the URL
  const targetUrl = opts.url.trim() || "about:blank";
  if (targetUrl !== "about:blank") {
    const navigationPolicy = withBrowserNavigationPolicy(opts.ssrfPolicy);
    await assertBrowserNavigationAllowed({
      url: targetUrl,
      ...navigationPolicy,
    });
    const response = await page.goto(targetUrl, { timeout: 30_000 }).catch(() => {
      // Navigation might fail for some URLs, but page is still created
      return null;
    });
    await assertBrowserNavigationRedirectChainAllowed({
      request: response?.request(),
      ...navigationPolicy,
    });
    await assertBrowserNavigationResultAllowed({
      url: page.url(),
      ...navigationPolicy,
    });
  }

  // Get the targetId for this page
  const tid = await pageTargetId(page).catch(() => null);
  if (!tid) {
    throw new Error("Failed to get targetId for new page");
  }

  return {
    targetId: tid,
    title: await page.title().catch(() => ""),
    url: page.url(),
    type: "page",
  };
}

/**
 * Close a page/tab by targetId using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/close is ephemeral.
 */
export async function closePageByTargetIdViaPlaywright(opts: {
  cdpUrl: string;
  targetId: string;
}): Promise<void> {
  const page = await resolvePageByTargetIdOrThrow(opts);
  await page.close();
}

/**
 * Focus a page/tab by targetId using the persistent Playwright connection.
 * Used for remote profiles where HTTP-based /json/activate can be ephemeral.
 */
export async function focusPageByTargetIdViaPlaywright(opts: {
  cdpUrl: string;
  targetId: string;
}): Promise<void> {
  const page = await resolvePageByTargetIdOrThrow(opts);
  try {
    await page.bringToFront();
  } catch (err) {
    try {
      await withPageScopedCdpClient({
        cdpUrl: opts.cdpUrl,
        page,
        targetId: opts.targetId,
        fn: async (send) => {
          await send("Page.bringToFront");
        },
      });
      return;
    } catch {
      throw err;
    }
  }
}
