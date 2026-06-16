import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(async () => ({
    ok: true,
    format: "ai",
    targetId: "t1",
    url: "https://example.com",
    snapshot: "ok",
  })),
}));

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: gatewayMocks.callGatewayFromCli,
}));

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ browser: {} })),
}));
vi.mock("../config/config.js", () => configMocks);

const sharedMocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(
    async (_opts: unknown, params: { path?: string; query?: Record<string, unknown> }) => {
      if (params.path === "/screenshot") {
        return { path: "/tmp/clawser-shot.png" };
      }
      const format = params.query?.format === "aria" ? "aria" : "ai";
      if (format === "aria") {
        return {
          ok: true,
          format: "aria",
          targetId: "t1",
          url: "https://example.com",
          nodes: [{ depth: 0, role: "button", name: "Save" }],
        };
      }
      return {
        ok: true,
        format: "ai",
        targetId: "t1",
        url: "https://example.com",
        snapshot: "ok",
        ...(params.query?.labels ? { imagePath: "/tmp/clawser-labels.png" } : {}),
      };
    },
  ),
}));
vi.mock("./browser-cli-shared.js", () => ({
  callBrowserRequest: sharedMocks.callBrowserRequest,
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};
vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

let registerBrowserInspectCommands: typeof import("./browser-cli-inspect.js").registerBrowserInspectCommands;

type SnapshotDefaultsCase = {
  label: string;
  args: string[];
  expectMode: "efficient" | undefined;
};

describe("browser cli snapshot defaults", () => {
  const runBrowserInspect = async (args: string[], withJson = false) => {
    const program = new Command();
    const browser = program.command("browser").option("--json", "JSON output", false);
    registerBrowserInspectCommands(browser, () => ({}));
    await program.parseAsync(withJson ? ["browser", "--json", ...args] : ["browser", ...args], {
      from: "user",
    });

    const [, params] = sharedMocks.callBrowserRequest.mock.calls.at(-1) ?? [];
    return params as { path?: string; query?: Record<string, unknown> } | undefined;
  };

  const runSnapshot = async (args: string[]) => await runBrowserInspect(["snapshot", ...args]);

  beforeAll(async () => {
    ({ registerBrowserInspectCommands } = await import("./browser-cli-inspect.js"));
  });

  afterEach(() => {
    vi.clearAllMocks();
    configMocks.loadConfig.mockReturnValue({ browser: {} });
  });

  it.each<SnapshotDefaultsCase>([
    {
      label: "uses config snapshot defaults when mode is not provided",
      args: [],
      expectMode: "efficient",
    },
    {
      label: "does not apply config snapshot defaults to aria snapshots",
      args: ["--format", "aria"],
      expectMode: undefined,
    },
  ])("$label", async ({ args, expectMode }) => {
    configMocks.loadConfig.mockReturnValue({
      browser: { snapshotDefaults: { mode: "efficient" } },
    });

    if (args.includes("--format")) {
      gatewayMocks.callGatewayFromCli.mockResolvedValueOnce({
        ok: true,
        format: "aria",
        targetId: "t1",
        url: "https://example.com",
        snapshot: "ok",
      });
    }

    const params = await runSnapshot(args);
    expect(params?.path).toBe("/snapshot");
    if (expectMode === undefined) {
      expect((params?.query as { mode?: unknown } | undefined)?.mode).toBeUndefined();
    } else {
      expect(params?.query).toMatchObject({
        format: "ai",
        mode: expectMode,
      });
    }
  });

  it("does not set mode when config defaults are absent", async () => {
    configMocks.loadConfig.mockReturnValue({ browser: {} });
    const params = await runSnapshot([]);
    expect((params?.query as { mode?: unknown } | undefined)?.mode).toBeUndefined();
  });

  it("applies explicit efficient mode without config defaults", async () => {
    configMocks.loadConfig.mockReturnValue({ browser: {} });
    const params = await runSnapshot(["--efficient"]);
    expect(params?.query).toMatchObject({
      format: "ai",
      mode: "efficient",
    });
  });

  it("sends default ai snapshot request and prints the snapshot", async () => {
    const params = await runSnapshot([]);
    expect(params?.path).toBe("/snapshot");
    expect(params?.query).toMatchObject({
      format: "ai",
    });
    expect(runtime.log).toHaveBeenCalledWith("ok");
  });

  it("sends explicit ai snapshot request", async () => {
    const params = await runSnapshot(["--format", "ai"]);
    expect(params?.path).toBe("/snapshot");
    expect(params?.query).toMatchObject({
      format: "ai",
    });
  });

  it("sends aria snapshot request and prints role nodes", async () => {
    const params = await runSnapshot(["--format", "aria"]);
    expect(params?.path).toBe("/snapshot");
    expect(params?.query).toMatchObject({
      format: "aria",
    });
    expect(runtime.log).toHaveBeenCalledWith('- button "Save"');
  });

  it("sends labels snapshot request and prints the labeled screenshot media path", async () => {
    const params = await runSnapshot(["--labels"]);
    expect(params?.path).toBe("/snapshot");
    expect(params?.query).toMatchObject({
      format: "ai",
      labels: true,
    });
    expect(runtime.log).toHaveBeenCalledWith("ok");
    expect(runtime.log).toHaveBeenCalledWith("MEDIA:/tmp/clawser-labels.png");
  });

  it("writes snapshot output to a file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-snapshot-out-"));
    const outPath = path.join(dir, "snapshot.txt");
    try {
      const params = await runSnapshot(["--out", outPath]);
      expect(params?.path).toBe("/snapshot");
      expect(params?.query).toMatchObject({
        format: "ai",
      });
      await expect(fs.readFile(outPath, "utf8")).resolves.toBe("ok");
      expect(runtime.log).toHaveBeenCalledWith(outPath);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("sends screenshot request with trimmed target id and jpeg type", async () => {
    const params = await runBrowserInspect(["screenshot", " tab-1 ", "--type", "jpeg"], true);
    expect(params?.path).toBe("/screenshot");
    expect((params as { body?: Record<string, unknown> } | undefined)?.body).toMatchObject({
      targetId: "tab-1",
      type: "jpeg",
      fullPage: false,
    });
  });

  it("sends default screenshot request", async () => {
    const params = await runBrowserInspect(["screenshot"]);
    expect(params?.path).toBe("/screenshot");
    expect((params as { body?: Record<string, unknown> } | undefined)?.body).toEqual({
      targetId: undefined,
      fullPage: false,
      ref: undefined,
      element: undefined,
      type: "png",
    });
    expect(runtime.log).toHaveBeenCalledWith("MEDIA:/tmp/clawser-shot.png");
  });

  it("sends full-page screenshot request", async () => {
    const params = await runBrowserInspect(["screenshot", "--full-page"]);
    expect(params?.path).toBe("/screenshot");
    expect((params as { body?: Record<string, unknown> } | undefined)?.body).toMatchObject({
      fullPage: true,
      type: "png",
    });
  });

  it("sends ref screenshot request", async () => {
    const params = await runBrowserInspect(["screenshot", "--ref", " ref-42 "]);
    expect(params?.path).toBe("/screenshot");
    expect((params as { body?: Record<string, unknown> } | undefined)?.body).toMatchObject({
      ref: "ref-42",
      fullPage: false,
      type: "png",
    });
  });

  it("sends element screenshot request", async () => {
    const params = await runBrowserInspect(["screenshot", "--element", " #main "]);
    expect(params?.path).toBe("/screenshot");
    expect((params as { body?: Record<string, unknown> } | undefined)?.body).toMatchObject({
      element: "#main",
      fullPage: false,
      type: "png",
    });
  });
});
