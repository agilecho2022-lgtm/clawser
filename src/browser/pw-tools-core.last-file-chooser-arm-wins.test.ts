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
  it.each(["pushState", "hash"])(
    "keeps an executable wait alive across same-document %s navigation",
    async () => {
      const events = new EventEmitter(),
        handlers = new Map<string, Function>();
      const frame = { _eventEmitter: events };
      let entered!: () => void, complete!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const handle = { dispose: vi.fn(async () => {}) };
      const waitForFunction = vi.fn(async () => {
        entered();
        await gate;
      });
      setPwToolsCoreCurrentPage({
        on: (name: string, handler: Function) => handlers.set(name, handler),
        off: vi.fn(),
        mainFrame: () => frame,
        evaluateHandle: async () => handle,
        waitForFunction,
      });
      const waiting = mod.waitForViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        fn: "window.ready",
      });
      void waiting.catch(() => {});
      await started;
      handlers.get("framenavigated")?.(frame);
      events.emit("navigated", { url: "https://test/route" });
      complete();
      await expect(waiting).resolves.toBeUndefined();
      expect(handle.dispose).toHaveBeenCalledOnce();
    },
  );
  it("times out Document capture and disposes its late handle without starting a predicate", async () => {
    const handle = { dispose: vi.fn(async () => {}) };
    const waitForFunction = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
    let release!: () => void;
    const capture = new Promise((resolve) => {
      release = () => resolve(handle);
    });
    setPwToolsCoreCurrentPage({
      on: vi.fn(),
      off: vi.fn(),
      mainFrame: () => ({ _eventEmitter: new EventEmitter() }),
      evaluateHandle: () => capture,
      waitForFunction,
    });
    const timer = setTimeout(release, 1000);
    try {
      await expect(
        mod.waitForViaPlaywright({ cdpUrl: "http://127.0.0.1:18792", fn: "true", timeoutMs: 600 }),
      ).rejects.toThrow(/600ms/);
      release();
      await new Promise((resolve) => setImmediate(resolve));
      expect(handle.dispose).toHaveBeenCalledOnce();
      expect(waitForFunction).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      release();
    }
  });
  it("does not start a predicate when its document changes during handle capture", async () => {
    const frame = { _eventEmitter: new EventEmitter() },
      handlers = new Map<string, (...args: unknown[]) => void>();
    let release!: (value: unknown) => void;
    const handle = { dispose: vi.fn(async () => {}) };
    const capture = new Promise((resolve) => {
      release = resolve;
    });
    const waitForFunction = vi.fn(async () => {});
    const page = {
      on: (event: string, listener: (...args: unknown[]) => void) => {
        handlers.set(event, listener);
      },
      off: vi.fn(),
      mainFrame: () => frame,
      evaluateHandle: vi.fn(() => capture),
      waitForFunction,
    };
    setPwToolsCoreCurrentPage(page);
    const pending = mod.waitForViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      fn: "() => true",
    });
    const rejected = expect(pending).rejects.toThrow(/document changed/);
    await vi.waitFor(() => expect(page.evaluateHandle).toHaveBeenCalled());
    frame._eventEmitter.emit("navigated", { newDocument: {} });
    release(handle);
    await rejected;
    expect(waitForFunction).not.toHaveBeenCalled();
    expect(handle.dispose).toHaveBeenCalledOnce();
  });
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
    const waitForFunction = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {});
    const waitForTimeout = vi.fn(async () => {});
    const documentHandle = { dispose: vi.fn(async () => {}) };

    const page = {
      locator: vi.fn(() => ({
        first: () => ({ waitFor: waitForSelector }),
      })),
      waitForURL,
      waitForLoadState,
      waitForFunction,
      waitForTimeout,
      mainFrame: () => ({ _eventEmitter: new EventEmitter() }),
      on: vi.fn(),
      off: vi.fn(),
      evaluateHandle: vi.fn(async () => documentHandle),
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
    expect(waitForFunction).toHaveBeenCalledWith(
      expect.any(Function),
      { document: documentHandle },
      { timeout: expect.any(Number) },
    );
    const functionOptions = waitForFunction.mock.calls[0]?.[2] as { timeout: number };
    expect(functionOptions.timeout).toBeGreaterThan(0);
    expect(functionOptions.timeout).toBeLessThanOrEqual(1234);
    expect(documentHandle.dispose).toHaveBeenCalledOnce();
  });
});
