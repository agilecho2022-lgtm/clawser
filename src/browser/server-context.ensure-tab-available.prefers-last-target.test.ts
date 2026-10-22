import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import type { BrowserServerState } from "./server-context.js";
import "./server-context.chrome-test-harness.js";
import { createBrowserRouteContext } from "./server-context.js";

function makeBrowserState(): BrowserServerState {
  return {
    // oxlint-disable-next-line typescript/no-explicit-any
    server: null as any,
    port: 0,
    resolved: {
      enabled: true,
      controlPort: 18791,
      cdpPortRangeStart: 18800,
      cdpPortRangeEnd: 18899,
      cdpProtocol: "http",
      cdpHost: "127.0.0.1",
      cdpIsLoopback: true,
      evaluateEnabled: false,
      remoteCdpTimeoutMs: 1500,
      remoteCdpHandshakeTimeoutMs: 3000,
      extraArgs: [],
      color: "#FF4500",
      headless: true,
      noSandbox: false,
      attachOnly: false,
      defaultProfile: "chrome",
      profiles: {
        chrome: {
          driver: "extension",
          cdpUrl: "http://127.0.0.1:18792",
          cdpPort: 18792,
          color: "#00AA00",
        },
        openclaw: { cdpPort: 18800, color: "#FF4500" },
      },
    },
    profiles: new Map(),
  };
}

function stubChromeJsonList(responses: unknown[]) {
  const fetchMock = vi.fn();
  const queue = [...responses];

  fetchMock.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (!u.includes("/json/list")) {
      throw new Error(`unexpected fetch: ${u}`);
    }
    const next = queue.shift();
    if (!next) {
      throw new Error("no more responses");
    }
    return {
      ok: true,
      json: async () => next,
    } as unknown as Response;
  });

  global.fetch = withFetchPreconnect(fetchMock);
  return fetchMock;
}

describe("browser server-context ensureTabAvailable", () => {
  it("sticks to the last selected target when targetId is omitted", async () => {
    // 1st call (snapshot): stable ordering A then B (twice)
    // 2nd call (act): reversed ordering B then A (twice)
    const responses = [
      [
        { id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" },
        { id: "B", type: "page", url: "https://b.example", webSocketDebuggerUrl: "ws://x/b" },
      ],
      [
        { id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" },
        { id: "B", type: "page", url: "https://b.example", webSocketDebuggerUrl: "ws://x/b" },
      ],
      [
        { id: "B", type: "page", url: "https://b.example", webSocketDebuggerUrl: "ws://x/b" },
        { id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" },
      ],
      [
        { id: "B", type: "page", url: "https://b.example", webSocketDebuggerUrl: "ws://x/b" },
        { id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" },
      ],
    ];
    stubChromeJsonList(responses);
    const state = makeBrowserState();

    const ctx = createBrowserRouteContext({
      getState: () => state,
    });

    const chrome = ctx.forProfile("chrome");
    const first = await chrome.ensureTabAvailable();
    expect(first.targetId).toBe("A");
    const second = await chrome.ensureTabAvailable();
    expect(second.targetId).toBe("A");
  });

  it("rejects invalid targetId even when only one extension tab remains", async () => {
    const responses = [
      [{ id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" }],
      [{ id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" }],
    ];
    stubChromeJsonList(responses);
    const state = makeBrowserState();

    const ctx = createBrowserRouteContext({ getState: () => state });
    const chrome = ctx.forProfile("chrome");
    await expect(chrome.ensureTabAvailable("NOT_A_TAB")).rejects.toThrow(/tab not found/i);
  });

  it("records explicit target lookup results without page content or URLs", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawser-target-lookup-"));
    const file = path.join(directory, "target.jsonl");
    vi.stubEnv("CLAWSER_TARGET_DIAGNOSTIC_LOG", file);
    try {
      stubChromeJsonList([
        [
          {
            id: "PROFILE",
            type: "page",
            url: "https://private.example/account",
            webSocketDebuggerUrl: "ws://x/a",
          },
        ],
        [
          {
            id: "PROFILE",
            type: "page",
            url: "https://private.example/account",
            webSocketDebuggerUrl: "ws://x/a",
          },
        ],
        [
          {
            id: "PROFILE",
            type: "page",
            url: "https://private.example/account",
            webSocketDebuggerUrl: "ws://x/a",
          },
        ],
        [
          {
            id: "PROFILE",
            type: "page",
            url: "https://private.example/account",
            webSocketDebuggerUrl: "ws://x/a",
          },
        ],
      ]);
      const ctx = createBrowserRouteContext({ getState: () => makeBrowserState() });
      const chrome = ctx.forProfile("chrome");
      await expect(chrome.ensureTabAvailable("PROFILE")).resolves.toMatchObject({
        targetId: "PROFILE",
      });
      await expect(chrome.ensureTabAvailable("MISSING")).rejects.toThrow(/tab not found/i);
      const text = fs.readFileSync(file, "utf8");
      const records = text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line.slice(line.indexOf("{"))));
      expect(records.map((record) => record.result)).toEqual(["found", "missing"]);
      expect(records.map((record) => record.candidate_count)).toEqual([1, 1]);
      expect(records.map((record) => record.source_layer)).toEqual([
        "server_context",
        "server_context",
      ]);
      expect(text).not.toContain("private.example");
      expect(text).not.toContain("account");
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records an empty attached-tab list as the source of target lookup failure", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "clawser-target-empty-"));
    const file = path.join(directory, "target.jsonl");
    vi.stubEnv("CLAWSER_TARGET_DIAGNOSTIC_LOG", file);
    try {
      stubChromeJsonList([[]]);
      const ctx = createBrowserRouteContext({ getState: () => makeBrowserState() });
      await expect(ctx.forProfile("chrome").ensureTabAvailable("MISSING")).rejects.toThrow(
        /no attached Chrome tabs/i,
      );
      const line = fs.readFileSync(file, "utf8").trim();
      const record = JSON.parse(line.slice(line.indexOf("{")));
      expect(record).toMatchObject({
        result: "missing",
        candidate_count: 0,
        source_layer: "server_context",
      });
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns a descriptive message when no extension tabs are attached", async () => {
    const responses = [[]];
    stubChromeJsonList(responses);
    const state = makeBrowserState();

    const ctx = createBrowserRouteContext({ getState: () => state });
    const chrome = ctx.forProfile("chrome");
    await expect(chrome.ensureTabAvailable()).rejects.toThrow(/no attached Chrome tabs/i);
  });

  it("waits briefly for extension tabs to reappear when a previous target exists", async () => {
    vi.useFakeTimers();
    try {
      const responses = [
        // First call: select tab A and store lastTargetId.
        [{ id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" }],
        [{ id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" }],
        // Second call: transient drop, then the extension re-announces attached tab A.
        [],
        [{ id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" }],
        [{ id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" }],
      ];
      stubChromeJsonList(responses);
      const state = makeBrowserState();

      const ctx = createBrowserRouteContext({ getState: () => state });
      const chrome = ctx.forProfile("chrome");
      const first = await chrome.ensureTabAvailable();
      expect(first.targetId).toBe("A");

      const secondPromise = chrome.ensureTabAvailable();
      await vi.advanceTimersByTimeAsync(250);
      const second = await secondPromise;
      expect(second.targetId).toBe("A");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still fails after the extension-tab grace window expires", async () => {
    vi.useFakeTimers();
    try {
      const responses = [
        [{ id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" }],
        [{ id: "A", type: "page", url: "https://a.example", webSocketDebuggerUrl: "ws://x/a" }],
        ...Array.from({ length: 20 }, () => []),
      ];
      stubChromeJsonList(responses);
      const state = makeBrowserState();

      const ctx = createBrowserRouteContext({ getState: () => state });
      const chrome = ctx.forProfile("chrome");
      await chrome.ensureTabAvailable();

      const pending = expect(chrome.ensureTabAvailable()).rejects.toThrow(
        /no attached Chrome tabs/i,
      );
      await vi.advanceTimersByTimeAsync(3_500);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
});
