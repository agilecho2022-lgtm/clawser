import { describe, expect, it, vi } from "vitest";
import {
  browserOnlyGatewayHandlers,
  handleBrowserOnlyGatewayRequest,
} from "./server-methods/browser-only.js";

const noWebchat = () => false;

function buildContext() {
  return {
    logGateway: {
      warn: vi.fn(),
    },
  } as unknown as Parameters<typeof handleBrowserOnlyGatewayRequest>[0]["context"];
}

describe("browser-only gateway handlers", () => {
  it("only exposes browser.request as a core RPC handler", () => {
    expect(Object.keys(browserOnlyGatewayHandlers).toSorted()).toEqual(["browser.request"]);
  });

  it("rejects non-browser RPC methods when using the browser-only dispatcher", async () => {
    const respond = vi.fn();

    await handleBrowserOnlyGatewayRequest({
      req: {
        type: "req",
        id: "req-1",
        method: "health",
      },
      respond,
      client: null,
      isWebchatConnect: noWebchat,
      context: buildContext(),
    });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        message: "unknown method: health",
      }),
    );
  });
});
