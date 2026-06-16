import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const sharedMocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(async (_parent: unknown, params: { path?: string }) => {
    if (params.path === "/console") {
      return { ok: true, messages: [{ level: "error", text: "boom" }] };
    }
    if (params.path === "/pdf") {
      return { ok: true, path: "/tmp/clawser/page.pdf" };
    }
    if (params.path === "/response/body") {
      return { ok: true, response: { body: "payload" } };
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

let registerBrowserActionObserveCommands: typeof import("./browser-cli-actions-observe.js").registerBrowserActionObserveCommands;

type BrowserRequestParams = {
  body?: Record<string, unknown>;
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
};

describe("browser observe cli commands", () => {
  beforeAll(async () => {
    ({ registerBrowserActionObserveCommands } = await import("./browser-cli-actions-observe.js"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function runBrowserObserve(args: string[]) {
    const program = new Command();
    const browser = program.command("browser").option("--json", "JSON output", false);
    registerBrowserActionObserveCommands(browser, () => ({}));
    await program.parseAsync(["browser", ...args], { from: "user" });
  }

  function lastBrowserRequest(): BrowserRequestParams {
    const [, params] = sharedMocks.callBrowserRequest.mock.calls.at(-1) ?? [];
    return (params ?? {}) as BrowserRequestParams;
  }

  it("sends console request", async () => {
    await runBrowserObserve(["console", "--level", " error "]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "GET",
      path: "/console",
      query: {
        level: "error",
        targetId: undefined,
        profile: undefined,
      },
    });
    expect(runtime.log).toHaveBeenCalledWith(
      JSON.stringify([{ level: "error", text: "boom" }], null, 2),
    );
  });

  it("sends pdf request", async () => {
    await runBrowserObserve(["pdf"]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "POST",
      path: "/pdf",
      query: undefined,
      body: { targetId: undefined },
    });
    expect(runtime.log).toHaveBeenCalledWith("PDF: /tmp/clawser/page.pdf");
  });

  it("sends response body request", async () => {
    await runBrowserObserve([
      "responsebody",
      "https://example.com/api",
      "--timeout-ms",
      "1234",
      "--max-chars",
      "99",
    ]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "POST",
      path: "/response/body",
      query: undefined,
      body: {
        url: "https://example.com/api",
        targetId: undefined,
        timeoutMs: 1234,
        maxChars: 99,
      },
    });
    expect(runtime.log).toHaveBeenCalledWith("payload");
  });
});
