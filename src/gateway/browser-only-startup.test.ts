import { describe, expect, it } from "vitest";
import {
  BROWSER_ONLY_GATEWAY_METHODS,
  createBrowserOnlyGatewaySurface,
} from "./browser-only-startup.js";

describe("browser-only gateway startup surface", () => {
  it("exposes only browser.request as a gateway method", () => {
    expect(BROWSER_ONLY_GATEWAY_METHODS).toEqual(["browser.request"]);
    expect(createBrowserOnlyGatewaySurface().gatewayMethods).toEqual(["browser.request"]);
  });

  it("uses the browser-only RPC handler set", () => {
    const surface = createBrowserOnlyGatewaySurface();

    expect(Object.keys(surface.coreGatewayHandlers)).toEqual(["browser.request"]);
  });
});
