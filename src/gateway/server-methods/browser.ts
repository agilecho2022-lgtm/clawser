import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "../../browser/control-service.js";
import { createBrowserRouteDispatcher } from "../../browser/routes/dispatcher.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import type { GatewayRequestHandlers, RespondFn } from "./types.js";

type BrowserRequestParams = {
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  timeoutMs?: number;
};

async function dispatchLocalBrowserRequest(params: {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, unknown>;
  body?: unknown;
  respond: RespondFn;
}) {
  const ready = await startBrowserControlServiceFromConfig();
  if (!ready) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.UNAVAILABLE, "browser control is disabled"),
    );
    return;
  }

  let dispatcher;
  try {
    dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
  } catch (err) {
    params.respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, String(err)));
    return;
  }

  const result = await dispatcher.dispatch({
    method: params.method,
    path: params.path,
    query: params.query,
    body: params.body,
  });

  if (result.status >= 400) {
    const message =
      result.body && typeof result.body === "object" && "error" in result.body
        ? String((result.body as { error?: unknown }).error)
        : `browser request failed (${result.status})`;
    const code = result.status >= 500 ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST;
    params.respond(false, undefined, errorShape(code, message, { details: result.body }));
    return;
  }

  params.respond(true, result.body);
}

export const browserHandlers: GatewayRequestHandlers = {
  "browser.request": async ({ params, respond }) => {
    const typed = params as BrowserRequestParams;
    const methodRaw = typeof typed.method === "string" ? typed.method.trim().toUpperCase() : "";
    const path = typeof typed.path === "string" ? typed.path.trim() : "";
    const query = typed.query && typeof typed.query === "object" ? typed.query : undefined;
    const body = typed.body;

    if (!methodRaw || !path) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "method and path are required"),
      );
      return;
    }
    if (methodRaw !== "GET" && methodRaw !== "POST" && methodRaw !== "DELETE") {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "method must be GET, POST, or DELETE"),
      );
      return;
    }
    await dispatchLocalBrowserRequest({
      method: methodRaw,
      path,
      query,
      body,
      respond,
    });
  },
};
