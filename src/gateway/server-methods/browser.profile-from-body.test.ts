import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  startBrowserControlServiceFromConfigMock,
  createBrowserControlContextMock,
  createBrowserRouteDispatcherMock,
  dispatchMock,
} = vi.hoisted(() => ({
  startBrowserControlServiceFromConfigMock: vi.fn(),
  createBrowserControlContextMock: vi.fn(),
  createBrowserRouteDispatcherMock: vi.fn(),
  dispatchMock: vi.fn(),
}));

vi.mock("../../browser/control-service.js", () => ({
  createBrowserControlContext: createBrowserControlContextMock,
  startBrowserControlServiceFromConfig: startBrowserControlServiceFromConfigMock,
}));

vi.mock("../../browser/routes/dispatcher.js", () => ({
  createBrowserRouteDispatcher: createBrowserRouteDispatcherMock,
}));

import { browserHandlers } from "./browser.js";

type RespondCall = [boolean, unknown?, { code: number; message: string }?];

async function runBrowserRequest(params: Record<string, unknown>) {
  const respond = vi.fn();
  await browserHandlers["browser.request"]({
    params,
    respond: respond as never,
    context: {} as never,
    client: null,
    req: { type: "req", id: "req-1", method: "browser.request" },
    isWebchatConnect: () => false,
  });
  return { respond };
}

describe("browser.request local dispatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startBrowserControlServiceFromConfigMock.mockResolvedValue({ ok: true });
    createBrowserControlContextMock.mockReturnValue({ context: true });
    dispatchMock.mockResolvedValue({ status: 200, body: { ok: true } });
    createBrowserRouteDispatcherMock.mockReturnValue({ dispatch: dispatchMock });
  });

  it("passes body profile through to the local browser dispatcher", async () => {
    const { respond } = await runBrowserRequest({
      method: "POST",
      path: "/act",
      body: { profile: "work", request: { action: "click", ref: "btn1" } },
    });

    expect(startBrowserControlServiceFromConfigMock).toHaveBeenCalled();
    expect(createBrowserControlContextMock).toHaveBeenCalled();
    expect(dispatchMock).toHaveBeenCalledWith({
      method: "POST",
      path: "/act",
      query: undefined,
      body: { profile: "work", request: { action: "click", ref: "btn1" } },
    });
    expect(respond).toHaveBeenCalledWith(true, { ok: true });
  });

  it("passes query and body profile fields through unchanged", async () => {
    await runBrowserRequest({
      method: "POST",
      path: "/act",
      query: { profile: "chrome" },
      body: { profile: "work", request: { action: "click", ref: "btn1" } },
    });

    expect(dispatchMock).toHaveBeenCalledWith({
      method: "POST",
      path: "/act",
      query: { profile: "chrome" },
      body: { profile: "work", request: { action: "click", ref: "btn1" } },
    });
  });

  it("returns unavailable when browser control is disabled", async () => {
    startBrowserControlServiceFromConfigMock.mockResolvedValue(null);

    const { respond } = await runBrowserRequest({
      method: "GET",
      path: "/status",
    });

    const call = respond.mock.calls[0] as RespondCall | undefined;
    expect(call?.[0]).toBe(false);
    expect(call?.[2]?.message).toBe("browser control is disabled");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      method: "POST",
      path: "/profiles/create",
      body: { name: "local", cdpUrl: "http://127.0.0.1:9222" },
    },
    {
      method: "DELETE",
      path: "/profiles/local",
      body: undefined,
    },
  ])(
    "dispatches persistent profile mutations locally for $method $path",
    async ({ method, path, body }) => {
      const { respond } = await runBrowserRequest({
        method,
        path,
        body,
      });

      expect(dispatchMock).toHaveBeenCalledWith({
        method,
        path,
        query: undefined,
        body,
      });
      expect(respond).toHaveBeenCalledWith(true, { ok: true });
    },
  );
});
