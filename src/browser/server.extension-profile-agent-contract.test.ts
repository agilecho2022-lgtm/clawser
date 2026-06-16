import { fetch as realFetch } from "undici";
import { describe, expect, it } from "vitest";
import {
  installAgentContractHooks,
  postJson,
  startServerAndBase,
} from "./server.agent-contract.test-harness.js";
import {
  getExtensionRelayMocks,
  getPwMocks,
  setBrowserControlServerReachable,
} from "./server.control-server.test-harness.js";

const extensionRelayMocks = getExtensionRelayMocks();
const pwMocks = getPwMocks();

describe("browser control server extension profile", () => {
  installAgentContractHooks();

  it("routes CLI snapshot, screenshot, click, and type through the extension relay profile", async () => {
    const base = await startServerAndBase();
    setBrowserControlServerReachable(false);
    const profileQuery = "profile=chrome";

    const snapAi = (await realFetch(`${base}/snapshot?format=ai&${profileQuery}`).then((r) =>
      r.json(),
    )) as {
      ok: boolean;
      format?: string;
    };
    expect(snapAi.ok).toBe(true);
    expect(snapAi.format).toBe("ai");
    expect(extensionRelayMocks.ensureChromeExtensionRelayServer).toHaveBeenCalledWith({
      cdpUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      bindHost: undefined,
    });
    const [relayStart] =
      extensionRelayMocks.ensureChromeExtensionRelayServer.mock.calls.at(-1) ?? [];
    const relayCdpUrl = (relayStart as { cdpUrl?: string } | undefined)?.cdpUrl;
    expect(relayCdpUrl).toEqual(expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/));

    expect(pwMocks.snapshotAiViaPlaywright).toHaveBeenCalledWith(
      expect.objectContaining({
        cdpUrl: relayCdpUrl,
        targetId: "abcd1234",
      }),
    );

    const shot = await postJson<{ ok: boolean; path?: string }>(
      `${base}/screenshot?${profileQuery}`,
      {
        type: "png",
      },
    );
    expect(shot.ok).toBe(true);
    expect(typeof shot.path).toBe("string");
    expect(pwMocks.takeScreenshotViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: relayCdpUrl,
      targetId: "abcd1234",
      ref: undefined,
      element: undefined,
      fullPage: false,
      type: "png",
    });

    const click = await postJson<{ ok: boolean }>(`${base}/act?${profileQuery}`, {
      kind: "click",
      ref: "1",
    });
    expect(click.ok).toBe(true);
    expect(pwMocks.clickViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: relayCdpUrl,
      targetId: "abcd1234",
      ref: "1",
      doubleClick: false,
    });

    const type = await postJson<{ ok: boolean }>(`${base}/act?${profileQuery}`, {
      kind: "type",
      ref: "2",
      text: "hello",
    });
    expect(type.ok).toBe(true);
    expect(pwMocks.typeViaPlaywright).toHaveBeenCalledWith({
      cdpUrl: relayCdpUrl,
      targetId: "abcd1234",
      ref: "2",
      text: "hello",
      submit: false,
      slowly: false,
    });
  });
});
