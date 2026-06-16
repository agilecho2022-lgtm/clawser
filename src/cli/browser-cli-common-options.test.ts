import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const statusPayload = {
  attachOnly: false,
  cdpPort: 18800,
  chosenBrowser: "chrome",
  color: "blue",
  enabled: true,
  headless: true,
  pid: 1,
  profile: "work",
  running: true,
  userDataDir: "/tmp/clawser",
};

const sharedMocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(async (_parent: unknown, params: { path?: string }) => {
    if (params.path === "/") {
      return statusPayload;
    }
    if (params.path === "/snapshot") {
      return { ok: true, format: "ai", snapshot: "snapshot" };
    }
    if (params.path === "/navigate") {
      return { ok: true, url: "https://example.com" };
    }
    if (params.path === "/console") {
      return { ok: true, messages: [] };
    }
    if (params.path === "/cookies") {
      return { ok: true, cookies: [] };
    }
    if (params.path === "/storage/local/set") {
      return { ok: true };
    }
    return { ok: true };
  }),
  callBrowserResize: vi.fn(async () => ({ ok: true })),
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

let registerBrowserCli: typeof import("./browser-cli.js").registerBrowserCli;

type BrowserRequestParams = {
  body?: Record<string, unknown>;
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
};

describe("browser cli common options", () => {
  beforeAll(async () => {
    ({ registerBrowserCli } = await import("./browser-cli.js"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function runBrowser(args: string[]) {
    const program = new Command();
    registerBrowserCli(program);
    await program.parseAsync(["browser", ...args], { from: "user" });
  }

  function lastBrowserRequest(): BrowserRequestParams {
    const [, params] = sharedMocks.callBrowserRequest.mock.calls.at(-1) ?? [];
    return (params ?? {}) as BrowserRequestParams;
  }

  it.each([
    {
      args: ["--browser-profile", "work", "status"],
      path: "/",
      query: { profile: "work" },
    },
    {
      args: ["--browser-profile", "work", "snapshot"],
      path: "/snapshot",
      query: { format: "ai", profile: "work" },
    },
    {
      args: ["--browser-profile", "work", "navigate", "https://example.com"],
      path: "/navigate",
      query: { profile: "work" },
    },
    {
      args: ["--browser-profile", "work", "console"],
      path: "/console",
      query: { level: undefined, targetId: undefined, profile: "work" },
    },
    {
      args: ["--browser-profile", "work", "highlight", "ref-1"],
      path: "/highlight",
      query: { profile: "work" },
    },
    {
      args: ["--browser-profile", "work", "cookies"],
      path: "/cookies",
      query: { targetId: undefined, profile: "work" },
    },
    {
      args: ["--browser-profile", "work", "storage", "local", "set", "token", "abc"],
      path: "/storage/local/set",
      query: { profile: "work" },
    },
    {
      args: ["--browser-profile", "work", "set", "offline", "on"],
      path: "/set/offline",
      query: { profile: "work" },
    },
  ])("passes --browser-profile to $path", async ({ args, path, query }) => {
    await runBrowser(args);

    expect(lastBrowserRequest()).toMatchObject({
      path,
      query,
    });
  });

  it("prints JSON output when --json is set", async () => {
    await runBrowser(["--json", "status"]);

    expect(runtime.log).toHaveBeenCalledWith(JSON.stringify(statusPayload, null, 2));
  });

  it("trims target ids before sending route requests", async () => {
    await runBrowser(["navigate", "https://example.com", "--target-id", " tab-1 "]);

    expect(lastBrowserRequest()).toMatchObject({
      path: "/navigate",
      body: {
        targetId: "tab-1",
      },
    });
  });

  it("passes tab focus target id or prefix unchanged to the browser route", async () => {
    await runBrowser(["focus", "57a01309"]);

    expect(lastBrowserRequest()).toMatchObject({
      method: "POST",
      path: "/tabs/focus",
      body: {
        targetId: "57a01309",
      },
    });
  });
});
