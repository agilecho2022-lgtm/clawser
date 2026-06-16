import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers, GatewayRequestOptions } from "./types.js";

export async function handleGatewayRequestWithHandlers(
  opts: GatewayRequestOptions & {
    coreHandlers: GatewayRequestHandlers;
    extraHandlers?: GatewayRequestHandlers;
  },
): Promise<void> {
  const { req, respond, client, isWebchatConnect, context } = opts;
  const handler = opts.extraHandlers?.[req.method] ?? opts.coreHandlers[req.method];
  if (!handler) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `unknown method: ${req.method}`),
    );
    return;
  }

  await handler({
    req,
    params: (req.params ?? {}) as Record<string, unknown>,
    client,
    isWebchatConnect,
    respond,
    context,
  });
}
