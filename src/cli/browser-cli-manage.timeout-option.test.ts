import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserManageCommands } from "./browser-cli-manage.js";
import { createBrowserProgram } from "./browser-cli-test-helpers.js";

const mocks = vi.hoisted(() => {
  const runtimeLog = vi.fn();
  const runtimeError = vi.fn();
  const runtimeExit = vi.fn();
  return {
    callBrowserRequest: vi.fn(
      async (_opts: unknown, req: { path?: string }): Promise<unknown> =>
        req.path === "/"
          ? {
              enabled: true,
              running: true,
              pid: 1,
              cdpPort: 18800,
              chosenBrowser: "chrome",
              userDataDir: "/tmp/clawser",
              color: "blue",
              headless: true,
              attachOnly: false,
            }
          : {},
    ),
    runtimeLog,
    runtimeError,
    runtimeExit,
    runtime: {
      log: runtimeLog,
      error: runtimeError,
      exit: runtimeExit,
    },
  };
});

vi.mock("./browser-cli-shared.js", () => ({
  callBrowserRequest: mocks.callBrowserRequest,
}));

vi.mock("./cli-utils.js", () => ({
  runCommandWithRuntime: async (
    _runtime: unknown,
    action: () => Promise<void>,
    onError: (err: unknown) => void,
  ) => await action().catch(onError),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("browser manage start timeout option", () => {
  function createProgram() {
    const { program, browser, parentOpts } = createBrowserProgram();
    browser.option("--timeout <ms>", "Timeout in ms", "30000");
    registerBrowserManageCommands(browser, parentOpts);
    return program;
  }

  async function parseBrowser(args: string[]) {
    const program = createProgram();
    await program.parseAsync(["browser", ...args], { from: "user" });
  }

  function requestedPaths() {
    return mocks.callBrowserRequest.mock.calls.map((call) => {
      const [, req] = call;
      return (req as { path?: string } | undefined)?.path;
    });
  }

  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    mocks.runtimeLog.mockClear();
    mocks.runtimeError.mockClear();
    mocks.runtimeExit.mockClear();
  });

  it("uses parent --timeout for browser start instead of hardcoded 15s", async () => {
    await parseBrowser(["--timeout", "60000", "start"]);

    const startCall = mocks.callBrowserRequest.mock.calls.find(
      (call) => ((call[1] ?? {}) as { path?: string }).path === "/start",
    ) as [Record<string, unknown>, { path?: string }, unknown] | undefined;

    expect(startCall).toBeDefined();
    expect(startCall?.[0]).toMatchObject({ timeout: "60000" });
    expect(startCall?.[2]).toBeUndefined();
  });

  it("inherits parent --json for nested tab new", async () => {
    mocks.callBrowserRequest.mockResolvedValueOnce({ ok: true, tab: { targetId: "tab-1" } });

    await parseBrowser(["--json", "tab", "new"]);

    expect(mocks.runtimeLog).toHaveBeenCalledWith(
      JSON.stringify({ ok: true, tab: { targetId: "tab-1" } }, null, 2),
    );
    expect(mocks.runtimeLog).not.toHaveBeenCalledWith("opened new tab");
  });

  it.each([
    { args: ["status"], paths: ["/"] },
    { args: ["start"], paths: ["/start", "/"] },
    { args: ["stop"], paths: ["/stop", "/"] },
    { args: ["tabs"], paths: ["/tabs"] },
    { args: ["attach"], paths: ["/tabs/action"] },
    { args: ["profiles"], paths: ["/profiles"] },
  ])("routes browser $args command through expected manage endpoint", async ({ args, paths }) => {
    await parseBrowser(args);

    expect(requestedPaths()).toEqual(paths);
  });

  it("sends attach-active tab action for browser attach", async () => {
    mocks.callBrowserRequest.mockResolvedValueOnce({
      ok: true,
      tab: { targetId: "tab-1", title: "Tab", url: "https://example.com" },
    });

    await parseBrowser(["attach"]);

    const [, req] = mocks.callBrowserRequest.mock.calls.at(-1) ?? [];
    expect(req).toMatchObject({
      method: "POST",
      path: "/tabs/action",
      body: { action: "attach-active" },
    });
    expect(mocks.runtimeLog).toHaveBeenCalledWith("attached active tab: https://example.com");
  });

  it("sends URL match for browser attach with an address argument", async () => {
    mocks.callBrowserRequest.mockResolvedValueOnce({
      ok: true,
      tabs: [{ targetId: "tab-1", title: "Tab", url: "https://foo.example.com/app" }],
    });

    await parseBrowser(["attach", "foo.example.com"]);

    const [, req] = mocks.callBrowserRequest.mock.calls.at(-1) ?? [];
    expect(req).toMatchObject({
      method: "POST",
      path: "/tabs/action",
      body: { action: "attach", urlContains: "foo.example.com" },
    });
    expect(mocks.runtimeLog).toHaveBeenCalledWith("attached 1 tab");
  });

  it("sends all-tabs mode for browser attach --all", async () => {
    mocks.callBrowserRequest.mockResolvedValueOnce({
      ok: true,
      tabs: [
        { targetId: "tab-1", title: "One", url: "https://one.example.com" },
        { targetId: "tab-2", title: "Two", url: "https://two.example.com" },
      ],
    });

    await parseBrowser(["attach", "--all"]);

    const [, req] = mocks.callBrowserRequest.mock.calls.at(-1) ?? [];
    expect(req).toMatchObject({
      method: "POST",
      path: "/tabs/action",
      body: { action: "attach", all: true },
    });
    expect(mocks.runtimeLog).toHaveBeenCalledWith("attached 2 tabs");
  });
});
