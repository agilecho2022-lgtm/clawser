import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import type WebSocket from "ws";
import { resolvePreferredClawserTmpDir } from "../infra/tmp-clawser-dir.js";
import { openCdpWebSocket } from "./cdp.helpers.js";
import { getChromeWebSocketUrl } from "./chrome.js";
import { writeViaSiblingTempPath } from "./output-atomic.js";
import { DEFAULT_UPLOAD_DIR, resolveStrictExistingPathsWithinRoot } from "./paths.js";
import {
  ensurePageState,
  getPageForTargetId,
  refLocator,
  restoreRoleRefsForTarget,
} from "./pw-session.js";
import { isExtensionRelayCdpEndpoint } from "./pw-session.page-cdp.js";
import {
  bumpDialogArmId,
  bumpDownloadArmId,
  bumpUploadArmId,
  normalizeTimeoutMs,
  requireRef,
  toAIFriendlyError,
} from "./pw-tools-core.shared.js";
import { snapshotRoleViaPlaywright } from "./pw-tools-core.snapshot.js";
import { sanitizeUntrustedFileName } from "./safe-filename.js";

function buildTempDownloadPath(fileName: string): string {
  const id = crypto.randomUUID();
  const safeName = sanitizeUntrustedFileName(fileName, "download.bin");
  return path.join(resolvePreferredClawserTmpDir(), "downloads", `${id}-${safeName}`);
}

function createPageDownloadWaiter(page: Page, timeoutMs: number) {
  let done = false;
  let timer: NodeJS.Timeout | undefined;
  let handler: ((download: unknown) => void) | undefined;

  const cleanup = () => {
    if (timer) {
      clearTimeout(timer);
    }
    timer = undefined;
    if (handler) {
      page.off("download", handler as never);
      handler = undefined;
    }
  };

  const promise = new Promise<unknown>((resolve, reject) => {
    handler = (download: unknown) => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
      resolve(download);
    };

    page.on("download", handler as never);
    timer = setTimeout(() => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
      reject(new Error("Timeout waiting for download"));
    }, timeoutMs);
  });

  return {
    promise,
    cancel: () => {
      if (done) {
        return;
      }
      done = true;
      cleanup();
    },
  };
}

type DownloadPayload = {
  url?: () => string;
  suggestedFilename?: () => string;
  saveAs?: (outPath: string) => Promise<void>;
};

type CdpWireMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
  sessionId?: string;
};

type CdpPending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

const extensionDialogArmIds = new Map<string, number>();

function targetArmKey(cdpUrl: string, targetId: string): string {
  return `${cdpUrl.replace(/\/$/, "")}::${targetId}`;
}

function isUnknownRefError(err: unknown, ref: string): boolean {
  return err instanceof Error && err.message.includes(`Unknown ref "${ref}"`);
}

async function refLocatorWithSnapshotFallback(opts: {
  cdpUrl: string;
  targetId?: string;
  page: Page;
  ref: string;
}) {
  try {
    return refLocator(opts.page, opts.ref);
  } catch (err) {
    if (!isUnknownRefError(err, opts.ref)) {
      throw err;
    }
    await snapshotRoleViaPlaywright({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      options: { interactive: true },
    });
    const refreshed = await getPageForTargetId(opts);
    ensurePageState(refreshed);
    restoreRoleRefsForTarget({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      page: refreshed,
    });
    return refLocator(refreshed, opts.ref);
  }
}

function parseCdpMessage(data: WebSocket.RawData): CdpWireMessage | null {
  try {
    return JSON.parse(rawDataToUtf8(data));
  } catch {
    return null;
  }
}

function rawDataToUtf8(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function createSocketCommandSender(ws: WebSocket) {
  let nextId = 1;
  const pending = new Map<number, CdpPending>();

  const send = (
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> => {
    const id = nextId;
    nextId += 1;
    ws.send(JSON.stringify({ id, method, params, sessionId }));
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  const rejectAll = (err: Error) => {
    for (const [, p] of pending) {
      p.reject(err);
    }
    pending.clear();
  };

  const handleMessage = (message: CdpWireMessage) => {
    if (typeof message.id !== "number") {
      return;
    }
    const p = pending.get(message.id);
    if (!p) {
      return;
    }
    pending.delete(message.id);
    if (message.error?.message) {
      p.reject(new Error(message.error.message));
      return;
    }
    p.resolve(message.result);
  };

  return { send, rejectAll, handleMessage };
}

async function openCdpSocket(wsUrl: string): Promise<WebSocket> {
  const ws = openCdpWebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
    ws.once("close", () => reject(new Error("CDP socket closed")));
  });
  return ws;
}

async function armDialogViaExtensionRelay(opts: {
  cdpUrl: string;
  targetId: string;
  accept: boolean;
  promptText?: string;
  timeoutMs: number;
  armId: number;
}): Promise<void> {
  const wsUrl = await getChromeWebSocketUrl(opts.cdpUrl, 2000);
  if (!wsUrl) {
    throw new Error("CDP websocket unavailable");
  }

  const key = targetArmKey(opts.cdpUrl, opts.targetId);
  const ws = await openCdpSocket(wsUrl);
  const cdp = createSocketCommandSender(ws);

  let done = false;
  let timer: NodeJS.Timeout | undefined;

  const cleanup = () => {
    if (done) {
      return;
    }
    done = true;
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (extensionDialogArmIds.get(key) === opts.armId) {
      extensionDialogArmIds.delete(key);
    }
    cdp.rejectAll(new Error("CDP dialog arm closed"));
    try {
      ws.close();
    } catch {
      // ignore
    }
  };

  ws.on("message", (data) => {
    const message = parseCdpMessage(data);
    if (!message) {
      return;
    }
    cdp.handleMessage(message);
    if (done || message.method !== "Page.javascriptDialogOpening") {
      return;
    }
    if (extensionDialogArmIds.get(key) !== opts.armId) {
      cleanup();
      return;
    }
    void cdp
      .send(
        "Page.handleJavaScriptDialog",
        {
          accept: opts.accept,
          ...(opts.accept && opts.promptText !== undefined ? { promptText: opts.promptText } : {}),
        },
        message.sessionId,
      )
      .catch(() => {
        // Another debugger client may already have handled the dialog.
      })
      .finally(cleanup);
  });
  ws.once("error", () => cleanup());
  ws.once("close", () => cleanup());

  const attached = (await cdp.send("Target.attachToTarget", {
    targetId: opts.targetId,
    flatten: true,
  })) as { sessionId?: string };
  const sessionId = String(attached?.sessionId ?? "").trim();
  await cdp.send("Page.enable", undefined, sessionId || undefined);
  timer = setTimeout(cleanup, opts.timeoutMs);
}

async function saveDownloadPayload(download: DownloadPayload, outPath: string) {
  const suggested = download.suggestedFilename?.() || "download.bin";
  const requestedPath = outPath?.trim();
  const resolvedOutPath = path.resolve(requestedPath || buildTempDownloadPath(suggested));
  await fs.mkdir(path.dirname(resolvedOutPath), { recursive: true });

  if (!requestedPath) {
    await download.saveAs?.(resolvedOutPath);
  } else {
    await writeViaSiblingTempPath({
      rootDir: path.dirname(resolvedOutPath),
      targetPath: resolvedOutPath,
      writeTemp: async (tempPath) => {
        await download.saveAs?.(tempPath);
      },
    });
  }

  return {
    url: download.url?.() || "",
    suggestedFilename: suggested,
    path: resolvedOutPath,
  };
}

async function awaitDownloadPayload(params: {
  waiter: ReturnType<typeof createPageDownloadWaiter>;
  state: ReturnType<typeof ensurePageState>;
  armId: number;
  outPath?: string;
}) {
  try {
    const download = (await params.waiter.promise) as DownloadPayload;
    if (params.state.armIdDownload !== params.armId) {
      throw new Error("Download was superseded by another waiter");
    }
    return await saveDownloadPayload(download, params.outPath ?? "");
  } catch (err) {
    params.waiter.cancel();
    throw err;
  }
}

export async function armFileUploadViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  paths?: string[];
  timeoutMs?: number;
}): Promise<void> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const timeout = Math.max(500, Math.min(120_000, opts.timeoutMs ?? 120_000));

  state.armIdUpload = bumpUploadArmId();
  const armId = state.armIdUpload;

  void page
    .waitForEvent("filechooser", { timeout })
    .then(async (fileChooser) => {
      if (state.armIdUpload !== armId) {
        return;
      }
      if (!opts.paths?.length) {
        // Playwright removed `FileChooser.cancel()`; best-effort close the chooser instead.
        try {
          await page.keyboard.press("Escape");
        } catch {
          // Best-effort.
        }
        return;
      }
      const uploadPathsResult = await resolveStrictExistingPathsWithinRoot({
        rootDir: DEFAULT_UPLOAD_DIR,
        requestedPaths: opts.paths,
        scopeLabel: `uploads directory (${DEFAULT_UPLOAD_DIR})`,
      });
      if (!uploadPathsResult.ok) {
        try {
          await page.keyboard.press("Escape");
        } catch {
          // Best-effort.
        }
        return;
      }
      await fileChooser.setFiles(uploadPathsResult.paths);
      try {
        const input =
          typeof fileChooser.element === "function"
            ? await Promise.resolve(fileChooser.element())
            : null;
        if (input) {
          await input.evaluate((el) => {
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          });
        }
      } catch {
        // Best-effort for sites that don't react to setFiles alone.
      }
    })
    .catch(() => {
      // Ignore timeouts; the chooser may never appear.
    });
}

export async function armDialogViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  accept: boolean;
  promptText?: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120_000);
  if (opts.targetId?.trim() && (await isExtensionRelayCdpEndpoint(opts.cdpUrl))) {
    const targetId = opts.targetId.trim();
    const armId = bumpDialogArmId();
    extensionDialogArmIds.set(targetArmKey(opts.cdpUrl, targetId), armId);
    try {
      await armDialogViaExtensionRelay({
        cdpUrl: opts.cdpUrl,
        targetId,
        accept: opts.accept,
        promptText: opts.promptText,
        timeoutMs: timeout,
        armId,
      });
    } catch (err) {
      const key = targetArmKey(opts.cdpUrl, targetId);
      if (extensionDialogArmIds.get(key) === armId) {
        extensionDialogArmIds.delete(key);
      }
      throw err;
    }
    return;
  }

  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);

  state.armIdDialog = bumpDialogArmId();
  const armId = state.armIdDialog;

  void page
    .waitForEvent("dialog", { timeout })
    .then(async (dialog) => {
      if (state.armIdDialog !== armId) {
        return;
      }
      if (opts.accept) {
        await dialog.accept(opts.promptText);
      } else {
        await dialog.dismiss();
      }
    })
    .catch(() => {
      // Ignore timeouts; the dialog may never appear.
    });
}

export async function waitForDownloadViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  path?: string;
  timeoutMs?: number;
}): Promise<{
  url: string;
  suggestedFilename: string;
  path: string;
}> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120_000);

  state.armIdDownload = bumpDownloadArmId();
  const armId = state.armIdDownload;

  const waiter = createPageDownloadWaiter(page, timeout);
  return await awaitDownloadPayload({ waiter, state, armId, outPath: opts.path });
}

export async function downloadViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  ref: string;
  path: string;
  timeoutMs?: number;
}): Promise<{
  url: string;
  suggestedFilename: string;
  path: string;
}> {
  const page = await getPageForTargetId(opts);
  const state = ensurePageState(page);
  restoreRoleRefsForTarget({ cdpUrl: opts.cdpUrl, targetId: opts.targetId, page });
  const timeout = normalizeTimeoutMs(opts.timeoutMs, 120_000);

  const ref = requireRef(opts.ref);
  const outPath = String(opts.path ?? "").trim();
  if (!outPath) {
    throw new Error("path is required");
  }

  state.armIdDownload = bumpDownloadArmId();
  const armId = state.armIdDownload;

  const waiter = createPageDownloadWaiter(page, timeout);
  try {
    const locator = await refLocatorWithSnapshotFallback({
      cdpUrl: opts.cdpUrl,
      targetId: opts.targetId,
      page,
      ref,
    });
    try {
      await locator.click({ timeout });
    } catch (err) {
      throw toAIFriendlyError(err, ref);
    }
    return await awaitDownloadPayload({ waiter, state, armId, outPath });
  } catch (err) {
    waiter.cancel();
    throw err;
  }
}
