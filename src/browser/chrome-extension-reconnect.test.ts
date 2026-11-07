import fs from "node:fs";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const utils = await import(
  new URL("../../chrome-extension/background-utils.js", import.meta.url).href
);
const source = fs.readFileSync(
  new URL("../../chrome-extension/background.js", import.meta.url),
  "utf8",
);
// Execute the shipping scheduler. Only the browser/network boundary is replaced.
const scheduler = source.slice(
  source.indexOf("function scheduleReconnect()"),
  source.indexOf("// Re-announce all attached tabs"),
);

function reconnectFixture(attempt = 0) {
  let available = false;
  const probes: number[] = [];
  const restored: number[] = [];
  const api = vm.runInNewContext(
    `let reconnectAttempt = ${attempt}; let reconnectTimer = null;
     ${scheduler}
     ({ scheduleReconnect, cancelReconnect })`,
    {
      ...utils,
      console: { log() {}, warn() {} },
      setTimeout,
      clearTimeout,
      ensureRelayConnection: async () => {
        probes.push(Date.now());
        if (!available) {
          throw new Error("Relay server not reachable");
        }
      },
      reannounceAttachedTabs: async () => {
        restored.push(Date.now());
      },
    },
  ) as { scheduleReconnect: () => void; cancelReconnect: () => void };
  return { ...api, probes, restored, recover: () => (available = true) };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("extension reconnect scheduling", () => {
  it("finds a restored relay within 2.5 seconds even after prolonged downtime", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    const f = reconnectFixture(20);
    f.scheduleReconnect();
    await vi.advanceTimersByTimeAsync(100);
    f.recover();
    await vi.advanceTimersByTimeAsync(2400);
    expect(f.probes).toHaveLength(1);
    expect(f.restored).toHaveLength(1);
    expect(f.restored[0]).toBeLessThanOrEqual(2500);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.probes).toHaveLength(1);
  });

  it("keeps retrying an offline relay without a busy loop and resets after recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const f = reconnectFixture();
    f.scheduleReconnect();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.probes).toEqual([1000, 3000, 5000, 7000, 9000]);
    expect(f.restored).toHaveLength(0);
    f.recover();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.restored).toEqual([11_000]);
    f.scheduleReconnect();
    await vi.advanceTimersByTimeAsync(999);
    expect(f.probes).toHaveLength(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.restored).toEqual([11_000, 12_000]);
  });

  it("cancels pending retries and keeps only one scheduled connection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const f = reconnectFixture(20);
    f.scheduleReconnect();
    f.cancelReconnect();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(f.probes).toHaveLength(0);
    f.recover();
    f.scheduleReconnect();
    f.scheduleReconnect();
    await vi.advanceTimersByTimeAsync(2500);
    expect(f.restored).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(f.probes).toHaveLength(1);
  });

  it("uses the fast default when optional reconnect settings are missing or invalid", () => {
    const invalid = { baseMs: Number.NaN, maxMs: Number.NaN, jitterMs: Number.NaN };
    vi.spyOn(Math, "random").mockReturnValue(0.999);
    for (const options of [undefined, {}, invalid]) {
      const delay = utils.reconnectDelayMs(20, options);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(2500);
    }
  });
});
