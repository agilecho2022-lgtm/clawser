import { expect, it, vi } from "vitest";
import type { BrowserRouteContext } from "../server-context.js";
import { registerBrowserTabRoutes } from "./tabs.js";
import type { BrowserRouteHandler, BrowserRouteRegistrar } from "./types.js";

it("the real delete route preserves the supplied close identity and caller", async () => {
  const closeTab = vi.fn(async () => {});
  const profile = { profile: { driver: "extension" }, isReachable: async () => true, closeTab };
  const ctx = {
    forProfile: () => profile,
    mapTabError: () => null,
  } as unknown as BrowserRouteContext;
  let handler!: BrowserRouteHandler;
  registerBrowserTabRoutes(
    {
      get() {},
      post() {},
      delete(_path, h) {
        handler = h;
      },
    } as BrowserRouteRegistrar,
    ctx,
  );
  const trace = {
    close_id: "route-close-1",
    initiator: "billrpa.screenshot_cleanup",
    initiator_pid: 123,
    task_id: "T",
    detail_id: "D",
  };
  await handler(
    { params: { targetId: "TARGET" }, query: {}, body: { closeTrace: trace } },
    { status: vi.fn().mockReturnThis(), json: vi.fn() },
  );
  expect(closeTab).toHaveBeenCalledExactlyOnceWith("TARGET", expect.objectContaining(trace));
});
