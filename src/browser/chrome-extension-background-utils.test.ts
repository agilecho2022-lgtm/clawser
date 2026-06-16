import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

type BackgroundUtilsModule = {
  buildRelayWsUrl: (port: number) => string;
  isLastRemainingTab: (
    allTabs: Array<{ id?: number | undefined } | null | undefined>,
    tabIdToClose: number,
  ) => boolean;
  isMissingTabError: (err: unknown) => boolean;
  isRetryableReconnectError: (err: unknown) => boolean;
  reconnectDelayMs: (
    attempt: number,
    opts?: { baseMs?: number; maxMs?: number; jitterMs?: number; random?: () => number },
  ) => number;
};

const require = createRequire(import.meta.url);
const BACKGROUND_UTILS_MODULES = [
  "../../assets/chrome-extension/background-utils.js",
  "../../chrome-extension/background-utils.js",
];

async function loadBackgroundUtils(): Promise<BackgroundUtilsModule> {
  let lastError: unknown;
  for (const modulePath of BACKGROUND_UTILS_MODULES) {
    try {
      return require(modulePath) as BackgroundUtilsModule;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("Cannot find module") && !message.includes("Unexpected token 'export'")) {
        throw error;
      }
      if (message.includes("Unexpected token 'export'")) {
        return (await import(modulePath)) as BackgroundUtilsModule;
      }
      lastError = error;
    }
  }
  throw lastError;
}

const {
  buildRelayWsUrl,
  isLastRemainingTab,
  isMissingTabError,
  isRetryableReconnectError,
  reconnectDelayMs,
} = await loadBackgroundUtils();

describe("chrome extension background utils", () => {
  it("builds websocket url with the fixed relay token", () => {
    expect(buildRelayWsUrl(18792)).toBe("ws://127.0.0.1:18792/extension?token=CLAWSER");
  });

  it("uses exponential backoff from attempt index", () => {
    expect(reconnectDelayMs(0, { baseMs: 1000, maxMs: 30000, jitterMs: 0, random: () => 0 })).toBe(
      1000,
    );
    expect(reconnectDelayMs(1, { baseMs: 1000, maxMs: 30000, jitterMs: 0, random: () => 0 })).toBe(
      2000,
    );
    expect(reconnectDelayMs(4, { baseMs: 1000, maxMs: 30000, jitterMs: 0, random: () => 0 })).toBe(
      16000,
    );
  });

  it("caps reconnect delay at max", () => {
    const delay = reconnectDelayMs(20, {
      baseMs: 1000,
      maxMs: 30000,
      jitterMs: 0,
      random: () => 0,
    });
    expect(delay).toBe(30000);
  });

  it("adds jitter using injected random source", () => {
    const delay = reconnectDelayMs(3, {
      baseMs: 1000,
      maxMs: 30000,
      jitterMs: 1000,
      random: () => 0.25,
    });
    expect(delay).toBe(8250);
  });

  it("sanitizes invalid attempts and options", () => {
    expect(reconnectDelayMs(-2, { baseMs: 1000, maxMs: 30000, jitterMs: 0, random: () => 0 })).toBe(
      1000,
    );
    expect(
      reconnectDelayMs(Number.NaN, {
        baseMs: Number.NaN,
        maxMs: Number.NaN,
        jitterMs: Number.NaN,
        random: () => 0,
      }),
    ).toBe(1000);
  });

  it("keeps transient network errors retryable", () => {
    expect(isRetryableReconnectError(new Error("WebSocket connect timeout"))).toBe(true);
    expect(isRetryableReconnectError(new Error("Relay server not reachable"))).toBe(true);
  });

  it("recognizes missing-tab debugger errors", () => {
    expect(isMissingTabError(new Error("No tab with given id"))).toBe(true);
    expect(isMissingTabError(new Error("tab not found"))).toBe(true);
    expect(isMissingTabError(new Error("Cannot access a chrome:// URL"))).toBe(false);
  });

  it("blocks closing the final remaining tab only", () => {
    expect(isLastRemainingTab([{ id: 7 }], 7)).toBe(true);
    expect(isLastRemainingTab([{ id: 7 }, { id: 8 }], 7)).toBe(false);
    expect(isLastRemainingTab([{ id: 7 }, { id: 8 }], 8)).toBe(false);
  });
});
