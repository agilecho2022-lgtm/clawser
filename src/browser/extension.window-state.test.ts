import fs from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

function extensionCommand() {
  const source = fs.readFileSync(
    new URL("../../chrome-extension/background.js", import.meta.url),
    "utf8",
  );
  const begin = source.indexOf("async function handleForwardCdpCommand(");
  const end = source.indexOf("\nfunction onDebuggerEvent", begin);
  const chrome = {
    tabs: { get: vi.fn(async () => ({ id: 7, windowId: 42 })), update: vi.fn() },
    windows: {
      get: vi.fn(async () => ({ id: 42, state: "minimized", focused: false })),
      update: vi.fn(),
    },
    debugger: {
      sendCommand: vi.fn(async (_target, method) => {
        if (method !== "Runtime.evaluate") {
          throw new Error("unsupported CDP method " + method);
        }
        return { result: { value: "hidden" } };
      }),
    },
  };
  const sandbox = {
    chrome,
    tabs: new Map([[7, { state: "connected", sessionId: "session-seven" }]]),
    getTabBySessionId: () => ({ tabId: 7 }),
    getTabByTargetId: (id: string) => (id === "own-target" ? 7 : null),
    setTimeout,
    clearTimeout,
  };
  const run = vm.runInNewContext(source.slice(begin, end) + "\nhandleForwardCdpCommand", sandbox);
  return { chrome, run };
}
describe("extension owning window observation", () => {
  it("reads the exact target window and page visibility without activating anything", async () => {
    const { chrome, run } = extensionCommand();
    await expect(
      run({ params: { method: "Clawser.getWindowState", params: { targetId: "own-target" } } }),
    ).resolves.toMatchObject({
      state: "minimized",
      focused: false,
      visibilityState: "hidden",
      windowId: 42,
    });
    expect(chrome.tabs.get).toHaveBeenCalledWith(7);
    expect(chrome.windows.get).toHaveBeenCalledWith(42);
    expect(chrome.debugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 7 },
      "Runtime.evaluate",
      expect.objectContaining({ expression: "document.visibilityState", returnByValue: true }),
    );
    expect(chrome.tabs.update).not.toHaveBeenCalled();
    expect(chrome.windows.update).not.toHaveBeenCalled();
  });
  it("does not fall back to another attached target", async () => {
    const { run, chrome } = extensionCommand();
    await expect(
      run({ params: { method: "Clawser.getWindowState", params: { targetId: "lost-target" } } }),
    ).rejects.toThrow(/target|attached/i);
    expect(chrome.tabs.get).not.toHaveBeenCalled();
  });
});
