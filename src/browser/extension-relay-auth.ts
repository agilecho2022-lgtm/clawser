export const CHROME_EXTENSION_RELAY_AUTH_TOKEN = "CLAWSER";

const DEFAULT_RELAY_PROBE_TIMEOUT_MS = 500;
export function createRelayAuthToken(): string {
  return CHROME_EXTENSION_RELAY_AUTH_TOKEN;
}

export async function probeClawserRelay(params: {
  baseUrl: string;
  timeoutMs?: number;
}): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), params.timeoutMs ?? DEFAULT_RELAY_PROBE_TIMEOUT_MS);
  try {
    const statusUrl = new URL("/extension/status", `${params.baseUrl}/`).toString();
    const res = await fetch(statusUrl, { signal: ctrl.signal });
    if (!res.ok) {
      return false;
    }
    const body = (await res.json()) as { connected?: unknown };
    return typeof body?.connected === "boolean";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
