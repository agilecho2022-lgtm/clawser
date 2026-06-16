import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_UPLOAD_DIR } from "./paths.js";
import {
  installPwToolsCoreTestHooks,
  setPwToolsCoreCurrentPage,
} from "./pw-tools-core.test-harness.js";

installPwToolsCoreTestHooks();

class FakeCdpWebSocket extends EventEmitter {
  sent: Array<{ id: number; method: string; params?: unknown; sessionId?: string }> = [];

  send(payload: string) {
    const msg = JSON.parse(payload) as {
      id: number;
      method: string;
      params?: unknown;
      sessionId?: string;
    };
    this.sent.push(msg);
    setImmediate(() => {
      if (msg.method === "Target.attachToTarget") {
        this.emit(
          "message",
          Buffer.from(JSON.stringify({ id: msg.id, result: { sessionId: "session-1" } })),
        );
        return;
      }
      this.emit("message", Buffer.from(JSON.stringify({ id: msg.id, result: {} })));
    });
  }

  close() {
    this.emit("close");
  }
}

const cdpMocks = vi.hoisted(() => ({
  isExtensionRelayCdpEndpoint: vi.fn(async () => false),
  getChromeWebSocketUrl: vi.fn(async () => "ws://127.0.0.1:18792/cdp"),
  openCdpWebSocket: vi.fn(),
}));

vi.mock("./pw-session.page-cdp.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./pw-session.page-cdp.js")>()),
  isExtensionRelayCdpEndpoint: cdpMocks.isExtensionRelayCdpEndpoint,
}));

vi.mock("./chrome.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chrome.js")>()),
  getChromeWebSocketUrl: cdpMocks.getChromeWebSocketUrl,
}));

vi.mock("./cdp.helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cdp.helpers.js")>()),
  openCdpWebSocket: cdpMocks.openCdpWebSocket,
}));

const mod = await import("./pw-tools-core.js");

describe("pw-tools-core", () => {
  it("handles extension relay dialogs over the target CDP session", async () => {
    const ws = new FakeCdpWebSocket();
    cdpMocks.isExtensionRelayCdpEndpoint.mockResolvedValueOnce(true);
    cdpMocks.openCdpWebSocket.mockImplementationOnce(() => {
      setImmediate(() => ws.emit("open"));
      return ws;
    });

    const armed = mod.armDialogViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "target-1",
      accept: true,
      promptText: "ok",
      timeoutMs: 1000,
    });

    await armed;
    await vi.waitFor(() => {
      expect(ws.sent.some((msg) => msg.method === "Page.enable")).toBe(true);
    });

    ws.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          method: "Page.javascriptDialogOpening",
          sessionId: "session-1",
          params: { type: "confirm", message: "confirm?" },
        }),
      ),
    );

    await vi.waitFor(() => {
      expect(ws.sent).toContainEqual({
        id: expect.any(Number),
        method: "Page.handleJavaScriptDialog",
        params: { accept: true, promptText: "ok" },
        sessionId: "session-1",
      });
    });
  });

  it("last file-chooser arm wins", async () => {
    const firstPath = path.join(DEFAULT_UPLOAD_DIR, `vitest-arm-1-${crypto.randomUUID()}.txt`);
    const secondPath = path.join(DEFAULT_UPLOAD_DIR, `vitest-arm-2-${crypto.randomUUID()}.txt`);
    await fs.mkdir(DEFAULT_UPLOAD_DIR, { recursive: true });
    await Promise.all([
      fs.writeFile(firstPath, "1", "utf8"),
      fs.writeFile(secondPath, "2", "utf8"),
    ]);
    const secondCanonicalPath = await fs.realpath(secondPath);

    let resolve1: ((value: unknown) => void) | null = null;
    let resolve2: ((value: unknown) => void) | null = null;

    const fc1 = { setFiles: vi.fn(async () => {}) };
    const fc2 = { setFiles: vi.fn(async () => {}) };

    const waitForEvent = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve1 = r;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve2 = r;
          }),
      );

    setPwToolsCoreCurrentPage({
      waitForEvent,
      keyboard: { press: vi.fn(async () => {}) },
    });

    try {
      await mod.armFileUploadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        paths: [firstPath],
      });
      await mod.armFileUploadViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        paths: [secondPath],
      });

      if (!resolve1 || !resolve2) {
        throw new Error("file chooser handlers were not registered");
      }
      (resolve1 as (value: unknown) => void)(fc1);
      (resolve2 as (value: unknown) => void)(fc2);
      await Promise.resolve();

      expect(fc1.setFiles).not.toHaveBeenCalled();
      await vi.waitFor(() => {
        expect(fc2.setFiles).toHaveBeenCalledWith([secondCanonicalPath]);
      });
    } finally {
      await Promise.all([fs.rm(firstPath, { force: true }), fs.rm(secondPath, { force: true })]);
    }
  });
  it("arms the next dialog and accepts/dismisses (default timeout)", async () => {
    const accept = vi.fn(async () => {});
    const dismiss = vi.fn(async () => {});
    const dialog = { accept, dismiss };
    const waitForEvent = vi.fn(async () => dialog);
    setPwToolsCoreCurrentPage({
      waitForEvent,
    });

    await mod.armDialogViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      accept: true,
      promptText: "x",
    });
    await Promise.resolve();

    expect(waitForEvent).toHaveBeenCalledWith("dialog", { timeout: 120_000 });
    expect(accept).toHaveBeenCalledWith("x");
    expect(dismiss).not.toHaveBeenCalled();

    accept.mockClear();
    dismiss.mockClear();
    waitForEvent.mockClear();

    await mod.armDialogViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      accept: false,
    });
    await Promise.resolve();

    expect(waitForEvent).toHaveBeenCalledWith("dialog", { timeout: 120_000 });
    expect(dismiss).toHaveBeenCalled();
    expect(accept).not.toHaveBeenCalled();
  });
  it("waits for selector, url, load state, and function", async () => {
    const waitForSelector = vi.fn(async () => {});
    const waitForURL = vi.fn(async () => {});
    const waitForLoadState = vi.fn(async () => {});
    const waitForFunction = vi.fn(async () => {});
    const waitForTimeout = vi.fn(async () => {});

    const page = {
      locator: vi.fn(() => ({
        first: () => ({ waitFor: waitForSelector }),
      })),
      waitForURL,
      waitForLoadState,
      waitForFunction,
      waitForTimeout,
      getByText: vi.fn(() => ({ first: () => ({ waitFor: vi.fn() }) })),
    };
    setPwToolsCoreCurrentPage(page);

    await mod.waitForViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      selector: "#main",
      url: "**/dash",
      loadState: "networkidle",
      fn: "window.ready===true",
      timeoutMs: 1234,
      timeMs: 50,
    });

    expect(waitForTimeout).toHaveBeenCalledWith(50);
    expect(page.locator as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("#main");
    expect(waitForSelector).toHaveBeenCalledWith({
      state: "visible",
      timeout: 1234,
    });
    expect(waitForURL).toHaveBeenCalledWith("**/dash", { timeout: 1234 });
    expect(waitForLoadState).toHaveBeenCalledWith("networkidle", {
      timeout: 1234,
    });
    expect(waitForFunction).toHaveBeenCalledWith("window.ready===true", {
      timeout: 1234,
    });
  });
});
