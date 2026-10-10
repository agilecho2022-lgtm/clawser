import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ local: vi.fn(), config: { browser: {} } }));
vi.mock("../config/config.js", () => ({ loadConfig: () => mocks.config }));
vi.mock("../browser/config.js", () => ({
  resolveBrowserConfig: () => ({
    controlPort: 19999,
    defaultProfile: "chrome",
    profiles: { chrome: { driver: "extension" }, managed: { driver: "openclaw" } },
  }),
  resolveProfile: (config: { profiles: Record<string, unknown> }, name: string) =>
    config.profiles[name],
}));
vi.mock("../browser/control-auth.js", () => ({ resolveBrowserControlAuth: () => ({}) }));
vi.mock("../gateway/server-methods/browser-only.js", () => ({
  handleBrowserOnlyGatewayRequest: mocks.local,
}));
vi.mock("./progress.js", () => ({ withProgress: (_: unknown, run: () => unknown) => run() }));
import { callGatewayFromCli } from "./gateway-rpc.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function abortingFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: unknown, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener("abort", () => reject(options.signal!.reason), {
            once: true,
          });
        }),
    ),
  );
  mocks.local.mockImplementation(async ({ respond }) => respond(true, { targetId: "duplicate" }));
}
describe("extension open transport timeout", () => {
  it.each([undefined, "chrome"])(
    "surfaces the original abort without creating another tab (profile=%s)",
    async (profile) => {
      abortingFetch();
      await expect(
        callGatewayFromCli(
          "browser.request",
          { json: true },
          {
            method: "POST",
            path: "/tabs/open",
            query: { profile },
            body: { url: "https://example.com" },
            timeoutMs: 15,
          },
        ),
      ).rejects.toMatchObject({
        name: "TimeoutError",
        message: "browser request timeout: POST /tabs/open (15 ms)",
      });
      expect(mocks.local).not.toHaveBeenCalled();
    },
  );
  it("preserves the managed-profile fallback", async () => {
    abortingFetch();
    await expect(
      callGatewayFromCli(
        "browser.request",
        { json: true },
        {
          method: "POST",
          path: "/tabs/open",
          query: { profile: "managed" },
          timeoutMs: 15,
        },
      ),
    ).resolves.toEqual({ targetId: "duplicate" });
    expect(mocks.local).toHaveBeenCalledOnce();
  });
  it("preserves fallback when the daemon never accepted a connection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    mocks.local.mockImplementation(async ({ respond }) => respond(true, { targetId: "one" }));
    await expect(
      callGatewayFromCli(
        "browser.request",
        { json: true },
        {
          method: "POST",
          path: "/tabs/open",
          timeoutMs: 15,
        },
      ),
    ).resolves.toEqual({ targetId: "one" });
  });
});
