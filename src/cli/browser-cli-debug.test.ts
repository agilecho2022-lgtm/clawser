import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const sharedMocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(async (_parent: unknown, params: { path?: string }) => {
    if (params.path === "/errors") {
      return { ok: true, errors: [{ timestamp: "2026-01-01T00:00:00Z", message: "boom" }] };
    }
    if (params.path === "/requests") {
      return {
        ok: true,
        requests: [
          {
            timestamp: "2026-01-01T00:00:00Z",
            method: "GET",
            status: 200,
            ok: true,
            url: "https://example.com/api",
          },
        ],
      };
    }
    if (params.path === "/trace/stop") {
      return { ok: true, path: "/tmp/clawser/trace.zip" };
    }
    return { ok: true };
  }),
}));

vi.mock("./browser-cli-shared.js", () => sharedMocks);

const runtime = {
  error: vi.fn(),
  exit: vi.fn(),
  log: vi.fn(),
};

vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

let registerBrowserDebugCommands: typeof import("./browser-cli-debug.js").registerBrowserDebugCommands;

type BrowserRequestParams = {
  body?: Record<string, unknown>;
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
};

describe("browser debug cli commands", () => {
  beforeAll(async () => {
    ({ registerBrowserDebugCommands } = await import("./browser-cli-debug.js"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function runBrowserDebug(args: string[]) {
    const program = new Command();
    const browser = program.command("browser").option("--json", "JSON output", false);
    registerBrowserDebugCommands(browser, () => ({}));
    await program.parseAsync(["browser", ...args], { from: "user" });
  }

  function lastBrowserRequest(): BrowserRequestParams {
    const [, params] = sharedMocks.callBrowserRequest.mock.calls.at(-1) ?? [];
    return (params ?? {}) as BrowserRequestParams;
  }

  it("sends highlight request", async () => {
    await runBrowserDebug(["highlight", " ref-1 "]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "POST",
      path: "/highlight",
      query: undefined,
      body: { ref: "ref-1", targetId: undefined },
    });
    expect(runtime.log).toHaveBeenCalledWith("highlighted ref-1");
  });

  it("sends errors request", async () => {
    await runBrowserDebug(["errors"]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "GET",
      path: "/errors",
      query: { targetId: undefined, filter: undefined, clear: false, profile: undefined },
    });
    expect(runtime.log).toHaveBeenCalledWith("2026-01-01T00:00:00Z boom");
  });

  it("sends errors clear request", async () => {
    await runBrowserDebug(["errors", "--clear"]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "GET",
      path: "/errors",
      query: { targetId: undefined, filter: undefined, clear: true, profile: undefined },
    });
  });

  it("sends requests request", async () => {
    await runBrowserDebug(["requests"]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "GET",
      path: "/requests",
      query: { targetId: undefined, filter: undefined, clear: false, profile: undefined },
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "2026-01-01T00:00:00Z GET 200 ok https://example.com/api",
    );
  });

  it("sends requests filter request", async () => {
    await runBrowserDebug(["requests", "--filter", " api "]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "GET",
      path: "/requests",
      query: { targetId: undefined, filter: "api", clear: false, profile: undefined },
    });
  });

  it("sends requests clear request", async () => {
    await runBrowserDebug(["requests", "--clear"]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "GET",
      path: "/requests",
      query: { targetId: undefined, filter: undefined, clear: true, profile: undefined },
    });
  });

  it("sends trace start request", async () => {
    await runBrowserDebug(["trace", "start"]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "POST",
      path: "/trace/start",
      query: undefined,
      body: {
        targetId: undefined,
        screenshots: true,
        snapshots: true,
        sources: false,
      },
    });
    expect(runtime.log).toHaveBeenCalledWith("trace started");
  });

  it("sends trace stop request", async () => {
    await runBrowserDebug(["trace", "stop", "--out", " trace.zip "]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "POST",
      path: "/trace/stop",
      query: undefined,
      body: { targetId: undefined, path: "trace.zip" },
    });
    expect(runtime.log).toHaveBeenCalledWith("TRACE:/tmp/clawser/trace.zip");
  });
});
