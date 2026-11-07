import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import { closePlaywrightBrowserConnection, getPageForTargetId } from "./pw-session.js";

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");

afterEach(async () => {
  (globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
  connectOverCdpSpy.mockClear();
  getChromeWebSocketUrlSpy.mockClear();
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("pw-session getPageForTargetId", () => {
  it("rejects a missing explicit target when only an unrelated page is available", async () => {
    connectOverCdpSpy.mockClear();
    getChromeWebSocketUrlSpy.mockClear();

    const pageOn = vi.fn();
    const contextOn = vi.fn();
    const browserOn = vi.fn();
    const browserClose = vi.fn(async () => {});

    const context = {
      pages: () => [],
      on: contextOn,
      newCDPSession: vi.fn(async () => {
        throw new Error("Not allowed");
      }),
    } as unknown as import("playwright-core").BrowserContext;

    const page = {
      on: pageOn,
      isClosed: () => false,
      context: () => context,
    } as unknown as import("playwright-core").Page;

    // Fill pages() after page exists.
    (context as unknown as { pages: () => unknown[] }).pages = () => [page];

    const browser = {
      contexts: () => [context],
      on: browserOn,
      close: browserClose,
    } as unknown as import("playwright-core").Browser;

    connectOverCdpSpy.mockResolvedValue(browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [],
    } as unknown as Response);

    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "NOT_A_TAB",
      }),
    ).rejects.toThrow(/tab not found/i);

    await closePlaywrightBrowserConnection();
    expect(browserClose).toHaveBeenCalled();
  });

  it("rejects ambiguous same-URL extension pages instead of guessing by array position", async () => {
    const context = { pages: () => [pageA, pageB], on: vi.fn(), newCDPSession: vi.fn() };
    const pageA = {
      on: vi.fn(),
      isClosed: () => false,
      context: () => context,
      url: () => "https://same.example/",
    };
    const pageB = {
      on: vi.fn(),
      isClosed: () => false,
      context: () => context,
      url: () => "https://same.example/",
    };
    const browser = { contexts: () => [context], on: vi.fn(), close: vi.fn(async () => {}) };
    connectOverCdpSpy.mockResolvedValue(browser as never);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url) =>
        ({
          ok: true,
          json: async () =>
            (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).includes(
              "/json/version",
            )
              ? { Browser: "Clawser/extension-relay" }
              : [
                  { id: "TARGET_A", url: "https://same.example/" },
                  { id: "TARGET_B", url: "https://same.example/" },
                ],
        }) as Response,
    );
    try {
      await expect(
        getPageForTargetId({ cdpUrl: "http://127.0.0.1:29993", targetId: "TARGET_B" }),
      ).rejects.toMatchObject({ status: 409 });
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("does not map two same-URL native targets onto the only currently published Page", async () => {
    const page = { on: vi.fn(), isClosed: () => false, url: () => "https://same.example/" };
    const context = { pages: () => [page], on: vi.fn() };
    connectOverCdpSpy.mockResolvedValue({
      contexts: () => [context],
      on: vi.fn(),
      close: vi.fn(async () => {}),
    } as never);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async (url) =>
        ({
          ok: true,
          json: async () =>
            (typeof url === "string" ? url : url instanceof URL ? url.href : url.url).includes(
              "/json/version",
            )
              ? { Browser: "Clawser/extension-relay" }
              : [
                  { id: "TARGET_A", url: "https://same.example/" },
                  { id: "TARGET_B", url: "https://same.example/" },
                ],
        }) as Response,
    );
    try {
      for (const targetId of ["TARGET_A", "TARGET_B"]) {
        await expect(
          getPageForTargetId({ cdpUrl: "http://127.0.0.1:29995", targetId }),
        ).rejects.toMatchObject({ status: 409 });
      }
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses normalized inventory only to classify identity unavailability, never to guess a native Page", async () => {
    const pageOn = vi.fn();
    const contextOn = vi.fn();
    const browserOn = vi.fn();
    const browserClose = vi.fn(async () => {});

    const context = {
      pages: () => [],
      on: contextOn,
      newCDPSession: vi.fn(async () => {
        throw new Error("Not allowed");
      }),
    } as unknown as import("playwright-core").BrowserContext;

    const pageA = {
      on: pageOn,
      isClosed: () => false,
      context: () => context,
      url: () => "https://alpha.example",
    } as unknown as import("playwright-core").Page;
    const pageB = {
      on: pageOn,
      isClosed: () => false,
      context: () => context,
      url: () => "https://beta.example",
    } as unknown as import("playwright-core").Page;

    (context as unknown as { pages: () => unknown[] }).pages = () => [pageA, pageB];

    const browser = {
      contexts: () => [context],
      on: browserOn,
      close: browserClose,
    } as unknown as import("playwright-core").Browser;

    connectOverCdpSpy.mockResolvedValue(browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "TARGET_A", url: "https://alpha.example" },
        { id: "TARGET_B", url: "https://beta.example" },
      ],
    } as Response);

    try {
      await expect(
        getPageForTargetId({
          cdpUrl: "ws://127.0.0.1:18792/devtools/browser/SESSION?token=abc",
          targetId: "TARGET_B",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://127.0.0.1:18792/json/list?token=abc",
        expect.any(Object),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("rejects unprovable relay identity without attempting a temporary page CDP session", async () => {
    const pageOn = vi.fn();
    const contextOn = vi.fn();
    const browserOn = vi.fn();
    const browserClose = vi.fn(async () => {});
    const newCDPSession = vi.fn(async () => {
      throw new Error("Target.attachToBrowserTarget: Not allowed");
    });

    const context = {
      pages: () => [],
      on: contextOn,
      newCDPSession,
    } as unknown as import("playwright-core").BrowserContext;

    const pageA = {
      on: pageOn,
      isClosed: () => false,
      context: () => context,
      url: () => "https://alpha.example",
    } as unknown as import("playwright-core").Page;
    const pageB = {
      on: pageOn,
      isClosed: () => false,
      context: () => context,
      url: () => "https://beta.example",
    } as unknown as import("playwright-core").Page;

    (context as unknown as { pages: () => unknown[] }).pages = () => [pageA, pageB];

    const browser = {
      contexts: () => [context],
      on: browserOn,
      close: browserClose,
    } as unknown as import("playwright-core").Browser;

    connectOverCdpSpy.mockResolvedValue(browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ Browser: "Clawser/extension-relay" }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          { id: "TARGET_A", url: "https://alpha.example" },
          { id: "TARGET_B", url: "https://beta.example" },
        ],
      } as Response);

    try {
      await expect(
        getPageForTargetId({
          cdpUrl: "http://127.0.0.1:19993",
          targetId: "TARGET_B",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(newCDPSession).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
