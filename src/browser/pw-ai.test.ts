import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("playwright-core", () => ({
  chromium: {
    connectOverCDP: vi.fn(),
  },
}));

type FakeSession = {
  send: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
};

function createPage(opts: { targetId: string; snapshotFull: string }) {
  const session: FakeSession = {
    send: vi.fn().mockResolvedValue({
      targetInfo: { targetId: opts.targetId },
    }),
    detach: vi.fn().mockResolvedValue(undefined),
  };
  const context = {
    newCDPSession: vi.fn().mockResolvedValue(session),
  };
  const click = vi.fn().mockResolvedValue(undefined);
  const locator = vi.fn().mockReturnValue({ click });
  const getByRole = vi.fn().mockReturnValue({ click });
  const page = {
    context: () => context,
    locator,
    getByRole,
    on: vi.fn(),
    _snapshotForAI: vi.fn().mockResolvedValue({ full: opts.snapshotFull }),
  };
  return { page, locator, getByRole, click };
}

function createBrowser(pages: unknown[]) {
  const ctx = {
    pages: () => pages,
    on: vi.fn(),
  };
  return {
    contexts: () => [ctx],
    on: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as import("playwright-core").Browser;
}

let chromiumMock: typeof import("playwright-core").chromium;
let snapshotAiViaPlaywright: typeof import("./pw-tools-core.snapshot.js").snapshotAiViaPlaywright;
let clickViaPlaywright: typeof import("./pw-tools-core.interactions.js").clickViaPlaywright;
let closePlaywrightBrowserConnection: typeof import("./pw-session.js").closePlaywrightBrowserConnection;

beforeAll(async () => {
  const pw = await import("playwright-core");
  chromiumMock = pw.chromium;
  ({ snapshotAiViaPlaywright } = await import("./pw-tools-core.snapshot.js"));
  ({ clickViaPlaywright } = await import("./pw-tools-core.interactions.js"));
  ({ closePlaywrightBrowserConnection } = await import("./pw-session.js"));
});

afterEach(async () => {
  await closePlaywrightBrowserConnection();
  vi.clearAllMocks();
});

describe("pw-ai refs", () => {
  it("keeps ai snapshot refs directly clickable as aria refs", async () => {
    const snapshot = [
      '- link "开始对话 与 DeepSeek 免费对话" [ref=e44] [cursor=pointer]:',
      "  - generic [ref=e45]: 开始对话",
    ].join("\n");
    const p1 = createPage({ targetId: "T1", snapshotFull: snapshot });
    const browser = createBrowser([p1.page]);
    (chromiumMock.connectOverCDP as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(browser);

    await snapshotAiViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
    });

    await clickViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "T1",
      ref: "e45",
    });

    expect(p1.getByRole).toHaveBeenCalledWith("link", {
      name: "开始对话 与 DeepSeek 免费对话",
      exact: true,
    });
    expect(p1.getByRole).not.toHaveBeenCalledWith("generic");
    expect(p1.click).toHaveBeenCalledTimes(1);
  });
});
