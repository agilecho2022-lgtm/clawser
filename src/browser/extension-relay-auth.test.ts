import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import {
  CHROME_EXTENSION_RELAY_AUTH_TOKEN,
  createRelayAuthToken,
  probeClawserRelay,
} from "./extension-relay-auth.js";
import { getFreePort } from "./test-port.js";

async function withRelayServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  run: (params: { port: number }) => Promise<void>,
) {
  const port = await getFreePort();
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });
  try {
    const actualPort = (server.address() as AddressInfo).port;
    await run({ port: actualPort });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("extension-relay-auth", () => {
  it("uses the fixed relay auth token for local CDP clients", () => {
    expect(createRelayAuthToken()).toBe(CHROME_EXTENSION_RELAY_AUTH_TOKEN);
    expect(createRelayAuthToken()).toBe("CLAWSER");
  });

  it("accepts openclaw relay status probe responses", async () => {
    await withRelayServer(
      (req, res) => {
        if (!req.url?.startsWith("/extension/status")) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ connected: false }));
      },
      async ({ port }) => {
        const ok = await probeClawserRelay({
          baseUrl: `http://127.0.0.1:${port}`,
        });
        expect(ok).toBe(true);
      },
    );
  });

  it("rejects probe responses with wrong shape", async () => {
    await withRelayServer(
      (req, res) => {
        if (!req.url?.startsWith("/extension/status")) {
          res.writeHead(404);
          res.end("not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      },
      async ({ port }) => {
        const ok = await probeClawserRelay({
          baseUrl: `http://127.0.0.1:${port}`,
        });
        expect(ok).toBe(false);
      },
    );
  });
});
