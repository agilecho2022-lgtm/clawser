const ORDINARY_COMMAND_TIMEOUT_MS = 30_000;
const AWAITED_RUNTIME_TIMEOUT_MS = 125_000;

type ActionBudget = {
  kind?: unknown;
  timeoutMs?: unknown;
  timeMs?: unknown;
  text?: unknown;
  textGone?: unknown;
  selector?: unknown;
  url?: unknown;
  loadState?: unknown;
  fn?: unknown;
};

/** Leave room for the action to return its own timeout instead of an outer transport abort. */
export function resolveBrowserActionTransportTimeoutMs(
  action: ActionBudget,
  fallbackMs = 20_000,
): number {
  if (action.kind !== "wait" && action.kind !== "evaluate") {
    return fallbackMs;
  }
  const stepMs = Math.max(
    500,
    Math.min(
      120_000,
      typeof action.timeoutMs === "number" && Number.isFinite(action.timeoutMs)
        ? action.timeoutMs
        : 20_000,
    ),
  );
  let budget = stepMs;
  if (action.kind === "wait") {
    const conditions = [
      action.text,
      action.textGone,
      action.selector,
      action.url,
      action.loadState,
      action.fn,
    ].filter((value) => typeof value === "string" && value.trim()).length;
    const delay =
      typeof action.timeMs === "number" && Number.isFinite(action.timeMs)
        ? Math.max(0, action.timeMs)
        : 0;
    budget = conditions * stepMs + delay;
  }
  return Math.min(2_147_483_647, Math.max(fallbackMs, Math.ceil(budget) + 5_000));
}

/** Keep Promise-bearing Runtime work inside the public 120s action budget plus transport slack. */
export function resolveExtensionCommandTimeoutMs(method: string, params?: unknown): number {
  const awaitPromise =
    params !== null &&
    typeof params === "object" &&
    "awaitPromise" in params &&
    params.awaitPromise === true;
  return method === "Runtime.awaitPromise" ||
    ((method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") && awaitPromise)
    ? AWAITED_RUNTIME_TIMEOUT_MS
    : ORDINARY_COMMAND_TIMEOUT_MS;
}
