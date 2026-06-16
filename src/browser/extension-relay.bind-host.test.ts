import { afterEach, describe, expect, it } from "vitest";
import {
  ensureChromeExtensionRelayServer,
  stopChromeExtensionRelayServer,
} from "./extension-relay.js";
import { getFreePort } from "./test-port.js";

describe("chrome extension relay bindHost coordination", () => {
  let cdpUrl = "";

  afterEach(async () => {
    if (cdpUrl) {
      await stopChromeExtensionRelayServer({ cdpUrl }).catch(() => {});
      cdpUrl = "";
    }
  });

  it("rebinds the relay when concurrent callers request different bind hosts", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;

    const [first, second] = await Promise.all([
      ensureChromeExtensionRelayServer({ cdpUrl }),
      ensureChromeExtensionRelayServer({ cdpUrl, bindHost: "0.0.0.0" }),
    ]);

    const settled = await ensureChromeExtensionRelayServer({
      cdpUrl,
      bindHost: "0.0.0.0",
    });

    expect(first.port).toBe(port);
    expect(second.port).toBe(port);
    expect(second).not.toBe(first);
    expect(second.bindHost).toBe("0.0.0.0");
    expect(settled).toBe(second);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
  });

  it("rejects non-loopback cdpUrl hosts", async () => {
    const port = await getFreePort();

    await expect(
      ensureChromeExtensionRelayServer({ cdpUrl: `http://192.0.2.10:${port}` }),
    ).rejects.toThrow("extension relay requires loopback cdpUrl host");
  });
});
