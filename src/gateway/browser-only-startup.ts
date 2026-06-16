import {
  browserOnlyGatewayHandlers,
  handleBrowserOnlyGatewayRequest,
} from "./server-methods/browser-only.js";

export const BROWSER_ONLY_GATEWAY_METHODS = ["browser.request"] as const;

export function createBrowserOnlyGatewaySurface() {
  return {
    coreGatewayHandlers: browserOnlyGatewayHandlers,
    gatewayMethods: [...BROWSER_ONLY_GATEWAY_METHODS],
    handleGatewayRequest: handleBrowserOnlyGatewayRequest,
  };
}
