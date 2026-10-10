import { describe, expect, it, vi } from "vitest";
import type { BrowserRouteContext } from "../server-context.js";
import { registerBrowserTabRoutes } from "./tabs.js";
import type { BrowserRouteHandler, BrowserRouteRegistrar } from "./types.js";

describe("abandoned extension open ownership", () => {
  it("closes only its late-created tab when the HTTP caller timed out", async () => {
    const ctrl = new AbortController();
    const closeTab = vi.fn(async () => {});
    const openTab = vi.fn(async () => {
      ctrl.abort();
      return { targetId: "late-owned" };
    });
    const ctx = {
      forProfile: () => ({
        profile: { driver: "extension" },
        ensureBrowserAvailable: async () => {},
        openTab,
        closeTab,
      }),
    } as unknown as BrowserRouteContext;
    let open!: BrowserRouteHandler;
    const app = {
      get: () => {},
      delete: () => {},
      post: (path: string, handler: BrowserRouteHandler) => {
        if (path === "/tabs/open") {
          open = handler;
        }
      },
    } as BrowserRouteRegistrar;
    registerBrowserTabRoutes(app, ctx);
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    await open(
      { params: {}, query: {}, body: { url: "https://example.com" }, signal: ctrl.signal },
      res,
    );
    expect(openTab).toHaveBeenCalledOnce();
    expect(closeTab).toHaveBeenCalledExactlyOnceWith("late-owned");
    expect(res.json).not.toHaveBeenCalled();
  });
});
