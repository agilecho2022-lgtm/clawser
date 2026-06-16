import { describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(async () => ({ ok: true })),
}));

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: gatewayMocks.callGatewayFromCli,
}));

const { callBrowserRequest } = await import("./browser-cli-shared.js");

describe("browser cli shared request options", () => {
  it("uses parent gateway timeout for browser request timeout when no command override is provided", async () => {
    await callBrowserRequest(
      { timeout: "60000" },
      {
        method: "GET",
        path: "/tabs",
      },
    );

    expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledWith(
      "browser.request",
      { timeout: "60000" },
      {
        method: "GET",
        path: "/tabs",
        query: undefined,
        body: undefined,
        timeoutMs: 60000,
      },
      { progress: undefined },
    );
  });

  it("uses command timeout override for gateway and browser request timeouts", async () => {
    await callBrowserRequest(
      { timeout: "60000" },
      {
        method: "GET",
        path: "/tabs",
      },
      { timeoutMs: 1500 },
    );

    expect(gatewayMocks.callGatewayFromCli).toHaveBeenCalledWith(
      "browser.request",
      { timeout: "1500" },
      {
        method: "GET",
        path: "/tabs",
        query: undefined,
        body: undefined,
        timeoutMs: 1500,
      },
      { progress: undefined },
    );
  });
});
