import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionMocks = vi.hoisted(() => ({
  getPageForTargetId: vi.fn(),
}));

vi.mock("./pw-session.js", () => ({
  getPageForTargetId: sessionMocks.getPageForTargetId,
}));

describe("dumpFramesHTMLViaPlaywright", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("captures HTML and metadata for every page frame", async () => {
    const mainFrame = {
      name: vi.fn(() => ""),
      url: vi.fn(() => "https://example.test/root"),
      parentFrame: vi.fn(() => null),
      evaluate: vi.fn(async () => "<html><body>root</body></html>"),
    };
    const childFrame = {
      name: vi.fn(() => "app"),
      url: vi.fn(() => "https://app.example.test/frame"),
      parentFrame: vi.fn(() => mainFrame),
      evaluate: vi.fn(async () => "<html><body>frame</body></html>"),
    };
    const page = {
      frames: vi.fn(() => [mainFrame, childFrame]),
    };
    sessionMocks.getPageForTargetId.mockResolvedValue(page);

    const { dumpFramesHTMLViaPlaywright } = await import("./pw-tools-core.frames.js");
    const result = await dumpFramesHTMLViaPlaywright({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
    });

    expect(sessionMocks.getPageForTargetId).toHaveBeenCalledWith({
      cdpUrl: "http://127.0.0.1:9222",
      targetId: "tab-1",
    });
    expect(result.frames).toEqual([
      {
        index: 0,
        name: "",
        url: "https://example.test/root",
        parentIndex: null,
        html: "<html><body>root</body></html>",
      },
      {
        index: 1,
        name: "app",
        url: "https://app.example.test/frame",
        parentIndex: 0,
        html: "<html><body>frame</body></html>",
      },
    ]);
  });
});
