import { createServer } from "node:http";
import { expect, it } from "vitest";
import { closePlaywrightBrowserConnection } from "./pw-session.js";
import { isExtensionRelayCdpEndpoint } from "./pw-session.page-cdp.js";

it("does not let a retired endpoint probe overwrite its successor classification", async () => {
  let received!: () => void, finishOld!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    received = resolve;
  });
  let count = 0;
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (++count === 1) {
      finishOld = () => response.end(JSON.stringify({ Browser: "Chrome/145.0" }));
      received();
    } else {
      response.end(JSON.stringify({ Browser: "Clawser/extension-relay" }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture port unavailable");
  }
  const url = `http://127.0.0.1:${address.port}`;
  try {
    const old = isExtensionRelayCdpEndpoint(url);
    await firstRequest;
    await closePlaywrightBrowserConnection({ cdpUrl: url });
    await expect(isExtensionRelayCdpEndpoint(url)).resolves.toBe(true);
    finishOld();
    await old;
    await expect(isExtensionRelayCdpEndpoint(url)).resolves.toBe(true);
    expect(count).toBe(2);
  } finally {
    finishOld?.();
    await closePlaywrightBrowserConnection({ cdpUrl: url });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
