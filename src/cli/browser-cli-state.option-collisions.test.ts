import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerBrowserStateCommands } from "./browser-cli-state.js";
import { createBrowserProgram as createBrowserProgramShared } from "./browser-cli-test-helpers.js";

const mocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(async (..._args: unknown[]) => ({ ok: true })),
  runBrowserResizeWithOutput: vi.fn(async (_params: unknown) => {}),
  runtime: {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock("./browser-cli-shared.js", () => ({
  callBrowserRequest: mocks.callBrowserRequest,
}));

vi.mock("./browser-cli-resize.js", () => ({
  runBrowserResizeWithOutput: mocks.runBrowserResizeWithOutput,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
}));

describe("browser state option collisions", () => {
  const createStateProgram = ({ withGatewayUrl = false } = {}) => {
    const { program, browser, parentOpts } = createBrowserProgramShared({ withGatewayUrl });
    registerBrowserStateCommands(browser, parentOpts);
    return program;
  };

  const getLastRequest = () => {
    const call = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(call).toBeDefined();
    if (!call) {
      throw new Error("expected browser request call");
    }
    return call[1] as {
      body?: Record<string, unknown>;
      method?: string;
      path?: string;
      query?: Record<string, unknown>;
    };
  };

  const runBrowserCommand = async (argv: string[]) => {
    const program = createStateProgram();
    await program.parseAsync(["browser", ...argv], { from: "user" });
  };

  const runBrowserCommandAndGetRequest = async (argv: string[]) => {
    await runBrowserCommand(argv);
    return getLastRequest();
  };

  beforeEach(() => {
    mocks.callBrowserRequest.mockClear();
    mocks.runBrowserResizeWithOutput.mockClear();
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.exit.mockClear();
  });

  it("forwards parent-captured --target-id on `browser cookies set`", async () => {
    const request = await runBrowserCommandAndGetRequest([
      "cookies",
      "set",
      "session",
      "abc",
      "--url",
      "https://example.com",
      "--target-id",
      "tab-1",
    ]);

    expect((request as { body?: { targetId?: string } }).body?.targetId).toBe("tab-1");
  });

  it("resolves --url via parent when addGatewayClientOptions captures it", async () => {
    const program = createStateProgram({ withGatewayUrl: true });
    await program.parseAsync(
      [
        "browser",
        "--url",
        "ws://gw",
        "cookies",
        "set",
        "session",
        "abc",
        "--url",
        "https://example.com",
      ],
      { from: "user" },
    );
    const call = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(call).toBeDefined();
    const request = call![1] as { body?: { cookie?: { url?: string } } };
    expect(request.body?.cookie?.url).toBe("https://example.com");
  });

  it("inherits --url from parent when subcommand does not provide it", async () => {
    const program = createStateProgram({ withGatewayUrl: true });
    await program.parseAsync(
      ["browser", "--url", "https://inherited.example.com", "cookies", "set", "session", "abc"],
      { from: "user" },
    );
    const call = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(call).toBeDefined();
    const request = call![1] as { body?: { cookie?: { url?: string } } };
    expect(request.body?.cookie?.url).toBe("https://inherited.example.com");
  });

  it("accepts legacy parent `--json` by parsing payload via positional headers fallback", async () => {
    const request = (await runBrowserCommandAndGetRequest([
      "set",
      "headers",
      "--json",
      '{"x-auth":"ok"}',
    ])) as {
      body?: { headers?: Record<string, string> };
    };
    expect(request.body?.headers).toEqual({ "x-auth": "ok" });
  });

  it("filters non-string header values from JSON payload", async () => {
    const request = (await runBrowserCommandAndGetRequest([
      "set",
      "headers",
      "--json",
      '{"x-auth":"ok","retry":3,"enabled":true}',
    ])) as {
      body?: { headers?: Record<string, string> };
    };
    expect(request.body?.headers).toEqual({ "x-auth": "ok" });
  });

  it("sends set viewport through resize helper", async () => {
    await runBrowserCommand(["set", "viewport", "1440", "900"]);

    expect(mocks.runBrowserResizeWithOutput).toHaveBeenCalledWith({
      parent: { json: false },
      profile: undefined,
      width: 1440,
      height: 900,
      targetId: undefined,
      timeoutMs: 20000,
      successMessage: "viewport set: 1440x900",
    });
  });

  it("sends set offline request", async () => {
    const request = await runBrowserCommandAndGetRequest(["set", "offline", "on"]);

    expect(request).toMatchObject({
      body: {
        offline: true,
        targetId: undefined,
      },
    });
    const call = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(call?.[1]).toMatchObject({ method: "POST", path: "/set/offline" });
  });

  it("sends set headers request", async () => {
    const request = await runBrowserCommandAndGetRequest(["set", "headers", '{"x-auth":"ok"}']);

    expect(request).toMatchObject({
      body: {
        headers: { "x-auth": "ok" },
        targetId: undefined,
      },
    });
    const call = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(call?.[1]).toMatchObject({ method: "POST", path: "/set/headers" });
  });

  it("sends set credentials request", async () => {
    const request = await runBrowserCommandAndGetRequest(["set", "credentials", " ada ", "secret"]);

    expect(request).toMatchObject({
      body: {
        username: "ada",
        password: "secret",
        clear: false,
        targetId: undefined,
      },
    });
    const call = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(call?.[1]).toMatchObject({ method: "POST", path: "/set/credentials" });
  });

  it("sends set geo request", async () => {
    const request = await runBrowserCommandAndGetRequest([
      "set",
      "geo",
      "37.7749",
      "-122.4194",
      "--accuracy",
      "12",
      "--origin",
      " https://example.com ",
    ]);

    expect(request).toMatchObject({
      body: {
        latitude: 37.7749,
        longitude: -122.4194,
        accuracy: 12,
        origin: "https://example.com",
        clear: false,
        targetId: undefined,
      },
    });
    const call = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(call?.[1]).toMatchObject({ method: "POST", path: "/set/geolocation" });
  });

  it("sends set media request", async () => {
    const request = await runBrowserCommandAndGetRequest(["set", "media", "dark"]);

    expect(request).toMatchObject({
      body: {
        colorScheme: "dark",
        targetId: undefined,
      },
    });
    const call = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(call?.[1]).toMatchObject({ method: "POST", path: "/set/media" });
  });

  it("sends set timezone request", async () => {
    const request = await runBrowserCommandAndGetRequest(["set", "timezone", "America/New_York"]);

    expect(request).toMatchObject({
      body: {
        timezoneId: "America/New_York",
        targetId: undefined,
      },
    });
    const call = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(call?.[1]).toMatchObject({ method: "POST", path: "/set/timezone" });
  });

  it("sends set locale request", async () => {
    const request = await runBrowserCommandAndGetRequest(["set", "locale", "en-US"]);

    expect(request).toMatchObject({
      body: {
        locale: "en-US",
        targetId: undefined,
      },
    });
    const call = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(call?.[1]).toMatchObject({ method: "POST", path: "/set/locale" });
  });

  it("sends set device request", async () => {
    const request = await runBrowserCommandAndGetRequest(["set", "device", "iPhone 14"]);

    expect(request).toMatchObject({
      body: {
        name: "iPhone 14",
        targetId: undefined,
      },
    });
    const call = mocks.callBrowserRequest.mock.calls.at(-1);
    expect(call?.[1]).toMatchObject({ method: "POST", path: "/set/device" });
  });

  it("sends cookies read request", async () => {
    const request = await runBrowserCommandAndGetRequest(["cookies"]);

    expect(request).toMatchObject({
      method: "GET",
      path: "/cookies",
      query: {
        targetId: undefined,
        profile: undefined,
      },
    });
    expect(mocks.runtime.log).toHaveBeenCalledWith("[]");
  });

  it("sends cookies set request", async () => {
    const request = await runBrowserCommandAndGetRequest([
      "cookies",
      "set",
      "session",
      "abc",
      "--url",
      " https://example.com ",
    ]);

    expect(request).toMatchObject({
      method: "POST",
      path: "/cookies/set",
      query: undefined,
      body: {
        targetId: undefined,
        cookie: { name: "session", value: "abc", url: "https://example.com" },
      },
    });
    expect(mocks.runtime.log).toHaveBeenCalledWith("cookie set: session");
  });

  it("sends cookies clear request", async () => {
    const request = await runBrowserCommandAndGetRequest(["cookies", "clear"]);

    expect(request).toMatchObject({
      method: "POST",
      path: "/cookies/clear",
      query: undefined,
      body: {
        targetId: undefined,
      },
    });
    expect(mocks.runtime.log).toHaveBeenCalledWith("cookies cleared");
  });

  it.each([
    {
      args: ["storage", "local", "get", " token "],
      kind: "local",
      path: "/storage/local",
    },
    {
      args: ["storage", "session", "get", " token "],
      kind: "session",
      path: "/storage/session",
    },
  ])("sends $kind storage get request", async ({ args, path }) => {
    const request = await runBrowserCommandAndGetRequest(args);

    expect(request).toMatchObject({
      method: "GET",
      path,
      query: {
        key: "token",
        targetId: undefined,
        profile: undefined,
      },
    });
    expect(mocks.runtime.log).toHaveBeenCalledWith("{}");
  });

  it.each([
    {
      args: ["storage", "local", "set", "token", "abc"],
      kind: "local",
      path: "/storage/local/set",
      log: "localStorage set: token",
    },
    {
      args: ["storage", "session", "set", "token", "abc"],
      kind: "session",
      path: "/storage/session/set",
      log: "sessionStorage set: token",
    },
  ])("sends $kind storage set request", async ({ args, path, log }) => {
    const request = await runBrowserCommandAndGetRequest(args);

    expect(request).toMatchObject({
      method: "POST",
      path,
      query: undefined,
      body: {
        key: "token",
        value: "abc",
        targetId: undefined,
      },
    });
    expect(mocks.runtime.log).toHaveBeenCalledWith(log);
  });

  it.each([
    {
      args: ["storage", "local", "clear"],
      kind: "local",
      path: "/storage/local/clear",
      log: "localStorage cleared",
    },
    {
      args: ["storage", "session", "clear"],
      kind: "session",
      path: "/storage/session/clear",
      log: "sessionStorage cleared",
    },
  ])("sends $kind storage clear request", async ({ args, path, log }) => {
    const request = await runBrowserCommandAndGetRequest(args);

    expect(request).toMatchObject({
      method: "POST",
      path,
      query: undefined,
      body: {
        targetId: undefined,
      },
    });
    expect(mocks.runtime.log).toHaveBeenCalledWith(log);
  });

  it("errors when set offline receives an invalid value", async () => {
    await runBrowserCommand(["set", "offline", "maybe"]);

    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledWith(expect.stringContaining("Expected on|off"));
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("errors when set media receives an invalid value", async () => {
    await runBrowserCommand(["set", "media", "sepia"]);

    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Expected dark|light|none"),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("errors when headers JSON is missing", async () => {
    await runBrowserCommand(["set", "headers"]);

    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Missing headers JSON"),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });

  it("errors when headers JSON is not an object", async () => {
    await runBrowserCommand(["set", "headers", "--json", "[]"]);

    expect(mocks.callBrowserRequest).not.toHaveBeenCalled();
    expect(mocks.runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Headers JSON must be a JSON object"),
    );
    expect(mocks.runtime.exit).toHaveBeenCalledWith(1);
  });
});
