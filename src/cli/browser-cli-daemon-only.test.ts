import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { clearConfigCache } from "../config/config.js";
import { withEnvAsync } from "../test-utils/env.js";

// A daemon request must remain usable without loading the local browser engine.
// Eagerly loading that fallback puts its cold-start cost on every short CLI call.
vi.mock("../gateway/server-methods/browser-only.js", () => {
  throw new Error("local browser fallback loaded before it was needed");
});

async function withDaemon(status: number, body: unknown, run: () => Promise<void>) {
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer daemon-only-test") {
      res.writeHead(403).end();
      return;
    }
    expect(req.url).toBe("/tabs/window-state?profile=chrome&targetId=tab-035");
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "clawser-daemon-only-"));
  const configPath = path.join(scratch, "clawser.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      gateway: { port: port - 2, auth: { mode: "token", token: "daemon-only-test" } },
      browser: {
        defaultProfile: "chrome",
        profiles: {
          chrome: { driver: "extension", cdpUrl: "http://127.0.0.1:18494", color: "#0066CC" },
        },
      },
    }),
  );
  try {
    await withEnvAsync(
      {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: scratch,
        OPENCLAW_GATEWAY_PORT: undefined,
      },
      async () => {
        clearConfigCache();
        await run();
      },
    );
  } finally {
    clearConfigCache();
    await fs.rm(scratch, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function windowState() {
  const { callGatewayFromCli } = await import("./gateway-rpc.js");
  return callGatewayFromCli(
    "browser.request",
    { json: true },
    {
      method: "GET",
      path: "/tabs/window-state",
      query: { profile: "chrome", targetId: "tab-035" },
    },
  );
}

describe("daemon-only browser CLI", () => {
  it("returns the daemon response without loading local fallback dependencies", async () => {
    await withDaemon(200, { targetId: "tab-035", state: "normal" }, async () => {
      await expect(windowState()).resolves.toEqual({ targetId: "tab-035", state: "normal" });
    });
  });

  it("surfaces a daemon application error without loading the local fallback", async () => {
    await withDaemon(401, { error: "fetch failed from application" }, async () => {
      await expect(windowState()).rejects.toThrow("HTTP 401: fetch failed from application");
    });
  });
});
