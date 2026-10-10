import { createServer } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { createBrowserRouteContext } from "./server-context.js";
import { makeState } from "./server-context.remote-tab-ops.harness.js";

const cdp = vi.hoisted(() => ({ createTargetViaCdp: vi.fn() }));
vi.mock("./cdp.js", async (original) => ({
  ...(await original<typeof import("./cdp.js")>()),
  createTargetViaCdp: cdp.createTargetViaCdp,
}));
afterEach(() => vi.resetAllMocks());

for (const message of [
  "extension request timeout: Target.createTarget",
  "Extension not connected",
]) {
  it(`extension open preserves original error: ${message}`, async () => {
    let jsonNewCalls = 0;
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/json/new")) {
        jsonNewCalls++;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing server address");
    }
    const state = makeState("openclaw");
    state.resolved.profiles.openclaw = {
      driver: "extension",
      cdpPort: address.port,
      cdpUrl: `http://127.0.0.1:${address.port}`,
      color: "#FF4500",
    };
    const original = Object.assign(new TypeError(message), { code: "TEST_CDP_FAILURE" });
    cdp.createTargetViaCdp.mockRejectedValue(original);
    try {
      const ctx = createBrowserRouteContext({ getState: () => state });
      await expect(ctx.forProfile("openclaw").openTab("http://127.0.0.1/example")).rejects.toBe(
        original,
      );
      expect(jsonNewCalls).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

it("managed CDP profile retains its json/new fallback", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "fallback-target", url: "http://127.0.0.1/example" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("missing address");
  }
  const state = makeState("openclaw");
  state.resolved.profiles.openclaw.cdpPort = address.port;
  cdp.createTargetViaCdp.mockRejectedValue(new Error("CDP unavailable"));
  try {
    expect(
      (
        await createBrowserRouteContext({ getState: () => state })
          .forProfile("openclaw")
          .openTab("http://127.0.0.1/example")
      ).targetId,
    ).toBe("fallback-target");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
