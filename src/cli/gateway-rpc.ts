import type { Command } from "commander";
import { resolveBrowserConfig } from "../browser/config.js";
import { resolveBrowserControlAuth } from "../browser/control-auth.js";
import { loadConfig } from "../config/config.js";
import { handleBrowserOnlyGatewayRequest } from "../gateway/server-methods/browser-only.js";
import { withProgress } from "./progress.js";

export type GatewayRpcOpts = {
  url?: string;
  token?: string;
  timeout?: string;
  expectFinal?: boolean;
  json?: boolean;
};

export function addGatewayClientOptions(cmd: Command) {
  return cmd
    .option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)")
    .option("--token <token>", "Gateway token (if required)")
    .option("--timeout <ms>", "Timeout in ms", "30000")
    .option("--expect-final", "Wait for the final browser response", false);
}

type BrowserRequestParams = {
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
  body?: unknown;
  timeoutMs?: number;
};

function queryParamValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  return JSON.stringify(value) ?? "";
}

function buildBrowserControlUrl(params: BrowserRequestParams) {
  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const path = typeof params.path === "string" && params.path ? params.path : "/";
  const url = new URL(path, `http://127.0.0.1:${resolved.controlPort}`);
  if (params.query && typeof params.query === "object") {
    for (const [key, value] of Object.entries(params.query)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, queryParamValue(value));
      }
    }
  }
  return { cfg, url };
}

async function tryCallBrowserControlDaemon(
  params: BrowserRequestParams,
): Promise<{ handled: true; payload: unknown } | { handled: false }> {
  const method = typeof params.method === "string" ? params.method.toUpperCase() : "GET";
  if (method !== "GET" && method !== "POST" && method !== "DELETE") {
    return { handled: false };
  }

  const { cfg, url } = buildBrowserControlUrl(params);
  const headers = new Headers();
  headers.set("Accept", "application/json");
  const auth = resolveBrowserControlAuth(cfg);
  if (auth.token) {
    headers.set("Authorization", `Bearer ${auth.token}`);
  } else if (auth.password) {
    headers.set("x-openclaw-password", auth.password);
  }
  let body: string | undefined;
  if (params.body !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(params.body);
  }

  const ctrl = new AbortController();
  const timeoutMs =
    typeof params.timeoutMs === "number" && Number.isFinite(params.timeoutMs)
      ? Math.max(1, Math.floor(params.timeoutMs))
      : 5000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    const payload = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const message =
        payload && typeof payload === "object" && "error" in payload
          ? String((payload as { error?: unknown }).error)
          : text || `HTTP ${res.status}`;
      throw new Error(message);
    }
    return { handled: true, payload };
  } catch (err) {
    const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    if (
      message.includes("fetch failed") ||
      message.includes("econnrefused") ||
      message.includes("aborted")
    ) {
      return { handled: false };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function callGatewayFromCli(
  method: string,
  opts: GatewayRpcOpts,
  params?: unknown,
  extra?: { expectFinal?: boolean; progress?: boolean },
) {
  if (method !== "browser.request") {
    throw new Error(`unsupported browser-only RPC method: ${method}`);
  }
  if (opts.url || opts.token) {
    throw new Error("remote gateway RPC is not available in browser-only mode");
  }
  const showProgress = extra?.progress ?? opts.json !== true;
  return await withProgress(
    {
      label: `Gateway ${method}`,
      indeterminate: true,
      enabled: showProgress,
    },
    async () => {
      const typed = params as BrowserRequestParams;
      if (!opts.url && !opts.token) {
        const daemon = await tryCallBrowserControlDaemon(typed);
        if (daemon.handled) {
          return daemon.payload;
        }
      }
      let settled = false;
      let payload: unknown;
      let error: unknown;
      await handleBrowserOnlyGatewayRequest({
        req: {
          type: "req",
          id: "browser-cli-local",
          method,
          params,
        },
        client: null,
        isWebchatConnect: () => false,
        context: {
          logGateway: {
            warn: () => {},
          },
        } as Parameters<typeof handleBrowserOnlyGatewayRequest>[0]["context"],
        respond: (ok, result, err) => {
          settled = true;
          if (ok) {
            payload = result;
          } else {
            error = err;
          }
        },
      });
      if (!settled) {
        throw new Error("browser.request did not produce a response");
      }
      if (error) {
        const message =
          typeof error === "object" && error !== null && "message" in error
            ? String((error as { message?: unknown }).message)
            : error == null
              ? "unknown browser.request error"
              : typeof error === "string"
                ? error
                : JSON.stringify(error);
        throw new Error(message);
      }
      return payload;
    },
  );
}
