import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const sharedMocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(async (_parent: unknown, params: { path?: string; body?: unknown }) => {
    const body = params.body as { kind?: string } | undefined;
    if (params.path === "/navigate") {
      return { ok: true, url: "https://example.com/done" };
    }
    if (body?.kind === "evaluate") {
      return { ok: true, result: 42 };
    }
    if (params.path === "/wait/download" || params.path === "/download") {
      return { ok: true, download: { path: "/tmp/clawser/downloads/report.pdf" } };
    }
    return { ok: true };
  }),
  callBrowserResize: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../browser-cli-shared.js", () => sharedMocks);

const runtime = {
  error: vi.fn(),
  exit: vi.fn(),
  log: vi.fn(),
};

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtime,
}));

let registerBrowserActionInputCommands: typeof import("./register.js").registerBrowserActionInputCommands;

type BrowserRequestParams = {
  method?: string;
  path?: string;
  query?: Record<string, string> | undefined;
  body?: Record<string, unknown>;
};

describe("browser action input cli commands", () => {
  beforeAll(async () => {
    ({ registerBrowserActionInputCommands } = await import("./register.js"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function runBrowserAction(args: string[]) {
    const program = new Command();
    const browser = program.command("browser").option("--json", "JSON output", false);
    registerBrowserActionInputCommands(browser, () => ({}));
    await program.parseAsync(["browser", ...args], { from: "user" });
  }

  function lastBrowserRequest(): BrowserRequestParams {
    const [, params] = sharedMocks.callBrowserRequest.mock.calls.at(-1) ?? [];
    return (params ?? {}) as BrowserRequestParams;
  }

  it("sends navigate request", async () => {
    await runBrowserAction(["navigate", "https://example.com"]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "POST",
      path: "/navigate",
      body: { url: "https://example.com", targetId: undefined },
    });
    expect(runtime.log).toHaveBeenCalledWith("navigated to https://example.com/done");
  });

  it("sends resize request", async () => {
    await runBrowserAction(["resize", "1280", "720"]);
    expect(sharedMocks.callBrowserResize).toHaveBeenCalledWith(
      {},
      {
        profile: undefined,
        width: 1280,
        height: 720,
        targetId: undefined,
      },
      { timeoutMs: 20000 },
    );
    expect(runtime.log).toHaveBeenCalledWith("resized to 1280x720");
  });

  it.each([
    {
      name: "click",
      args: ["click", "12"],
      body: {
        kind: "click",
        ref: "12",
        targetId: undefined,
        doubleClick: false,
        button: undefined,
        modifiers: undefined,
      },
      log: "clicked ref 12",
    },
    {
      name: "type",
      args: ["type", "23", "hello"],
      body: {
        kind: "type",
        ref: "23",
        text: "hello",
        submit: false,
        slowly: false,
        targetId: undefined,
      },
      log: "typed into ref 23",
    },
    {
      name: "press",
      args: ["press", "Enter"],
      body: { kind: "press", key: "Enter", targetId: undefined },
      log: "pressed Enter",
    },
    {
      name: "hover",
      args: ["hover", "44"],
      body: { kind: "hover", ref: "44", targetId: undefined },
      log: "hovered ref 44",
    },
    {
      name: "scrollintoview",
      args: ["scrollintoview", "55"],
      body: {
        kind: "scrollIntoView",
        ref: "55",
        targetId: undefined,
        timeoutMs: undefined,
      },
      log: "scrolled into view: 55",
    },
    {
      name: "drag",
      args: ["drag", "10", "11"],
      body: { kind: "drag", startRef: "10", endRef: "11", targetId: undefined },
      log: "dragged 10 → 11",
    },
    {
      name: "select",
      args: ["select", "9", "OptionA", "OptionB"],
      body: { kind: "select", ref: "9", values: ["OptionA", "OptionB"], targetId: undefined },
      log: "selected OptionA, OptionB",
    },
  ])("sends $name act request", async ({ args, body, log }) => {
    await runBrowserAction(args);
    expect(lastBrowserRequest()).toMatchObject({
      method: "POST",
      path: "/act",
      body,
    });
    expect(runtime.log).toHaveBeenCalledWith(log);
  });

  it("sends fill request from inline fields JSON", async () => {
    await runBrowserAction(["fill", "--fields", '[{"ref":"1","value":"Ada"}]']);
    expect(lastBrowserRequest()).toMatchObject({
      method: "POST",
      path: "/act",
      body: {
        kind: "fill",
        fields: [{ ref: "1", type: "text", value: "Ada" }],
        targetId: undefined,
      },
    });
    expect(runtime.log).toHaveBeenCalledWith("filled 1 field(s)");
  });

  it("sends wait request", async () => {
    await runBrowserAction(["wait"]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "POST",
      path: "/act",
      body: {
        kind: "wait",
        targetId: undefined,
      },
    });
    expect(runtime.log).toHaveBeenCalledWith("wait complete");
  });

  it("sends evaluate request and prints result", async () => {
    await runBrowserAction(["evaluate", "--fn", "() => 42"]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "POST",
      path: "/act",
      body: {
        kind: "evaluate",
        fn: "() => 42",
        ref: undefined,
        targetId: undefined,
      },
    });
    expect(runtime.log).toHaveBeenCalledWith("42");
  });

  it("sends upload hook request", async () => {
    const uploadPath = path.join("/tmp/clawser/uploads", `cli-upload-${crypto.randomUUID()}.txt`);
    await fs.mkdir(path.dirname(uploadPath), { recursive: true });
    await fs.writeFile(uploadPath, "fixture", "utf8");
    const canonicalUploadPath = await fs.realpath(uploadPath);

    try {
      await runBrowserAction(["upload", uploadPath]);
      expect(lastBrowserRequest()).toMatchObject({
        method: "POST",
        path: "/hooks/file-chooser",
        body: {
          paths: [canonicalUploadPath],
          ref: undefined,
          inputRef: undefined,
          element: undefined,
          targetId: undefined,
          timeoutMs: undefined,
        },
      });
      expect(runtime.log).toHaveBeenCalledWith("upload armed for 1 file(s)");
    } finally {
      await fs.rm(uploadPath, { force: true });
    }
  });

  it("sends wait-for-download request", async () => {
    await runBrowserAction(["waitfordownload"]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "POST",
      path: "/wait/download",
      body: {
        path: undefined,
        targetId: undefined,
        timeoutMs: undefined,
      },
    });
    expect(runtime.log).toHaveBeenCalledWith("downloaded: /tmp/clawser/downloads/report.pdf");
  });

  it("sends download request", async () => {
    await runBrowserAction(["download", "e12", "report.pdf"]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "POST",
      path: "/download",
      body: {
        ref: "e12",
        path: "report.pdf",
        targetId: undefined,
        timeoutMs: undefined,
      },
    });
    expect(runtime.log).toHaveBeenCalledWith("downloaded: /tmp/clawser/downloads/report.pdf");
  });

  it("sends dialog accept hook request", async () => {
    await runBrowserAction(["dialog", "--accept", "--prompt", " ok "]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "POST",
      path: "/hooks/dialog",
      body: {
        accept: true,
        promptText: "ok",
        targetId: undefined,
        timeoutMs: undefined,
      },
    });
    expect(runtime.log).toHaveBeenCalledWith("dialog armed");
  });

  it("sends dialog dismiss hook request", async () => {
    await runBrowserAction(["dialog", "--dismiss"]);
    expect(lastBrowserRequest()).toMatchObject({
      method: "POST",
      path: "/hooks/dialog",
      body: {
        accept: false,
        promptText: undefined,
        targetId: undefined,
        timeoutMs: undefined,
      },
    });
    expect(runtime.log).toHaveBeenCalledWith("dialog armed");
  });
});
