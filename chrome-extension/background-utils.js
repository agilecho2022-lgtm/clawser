const RELAY_AUTH_TOKEN = 'CLAWSER';

export function reconnectDelayMs(
  attempt,
  opts = { baseMs: 1000, maxMs: 30000, jitterMs: 1000, random: Math.random },
) {
  const baseMs = Number.isFinite(opts.baseMs) ? opts.baseMs : 1000;
  const maxMs = Number.isFinite(opts.maxMs) ? opts.maxMs : 30000;
  const jitterMs = Number.isFinite(opts.jitterMs) ? opts.jitterMs : 1000;
  const random = typeof opts.random === "function" ? opts.random : Math.random;
  const safeAttempt = Math.max(0, Number.isFinite(attempt) ? attempt : 0);
  const backoff = Math.min(baseMs * 2 ** safeAttempt, maxMs);
  return backoff + Math.max(0, jitterMs) * random();
}

export function buildRelayWsUrl(port) {
  return `ws://127.0.0.1:${port}/extension?token=${encodeURIComponent(RELAY_AUTH_TOKEN)}`;
}

export function isRetryableReconnectError() {
  return true;
}

export function isMissingTabError(err) {
  const message = (err instanceof Error ? err.message : String(err || "")).toLowerCase();
  return (
    message.includes("no tab with id") ||
    message.includes("no tab with given id") ||
    message.includes("tab not found")
  );
}

export function isLastRemainingTab(allTabs, tabIdToClose) {
  if (!Array.isArray(allTabs)) {
    return true;
  }
  return allTabs.filter((tab) => tab && tab.id !== tabIdToClose).length === 0;
}
