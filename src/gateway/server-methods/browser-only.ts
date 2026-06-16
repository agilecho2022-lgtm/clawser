import { browserHandlers } from "./browser.js";
import { handleGatewayRequestWithHandlers } from "./dispatcher.js";
import type { GatewayRequestHandlers, GatewayRequestOptions } from "./types.js";

export const browserOnlyGatewayHandlers: GatewayRequestHandlers = {
  ...browserHandlers,
};

export async function handleBrowserOnlyGatewayRequest(
  opts: GatewayRequestOptions & { extraHandlers?: GatewayRequestHandlers },
): Promise<void> {
  await handleGatewayRequestWithHandlers({
    ...opts,
    coreHandlers: browserOnlyGatewayHandlers,
  });
}
