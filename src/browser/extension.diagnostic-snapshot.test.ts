import fs from "node:fs";
import vm from "node:vm";
import { expect, it, vi } from "vitest";

it("snapshot includes discarded unattached tabs and exact window state without waking or attaching", async () => {
  const source = fs.readFileSync(
    new URL("../../chrome-extension/background.js", import.meta.url),
    "utf8",
  );
  const begin = source.indexOf("async function handleForwardCdpCommand(");
  const end = source.indexOf("\nfunction onDebuggerEvent", begin);
  const chrome = {
    tabs: {
      query: vi.fn(async () => [
        {
          id: 7,
          url: "https://qdd.test/a",
          discarded: true,
          autoDiscardable: false,
          frozen: false,
          status: "unloaded",
          active: true,
          windowId: 42,
        },
        {
          id: 8,
          url: "https://ywb.test/b",
          discarded: false,
          autoDiscardable: true,
          frozen: true,
          status: "complete",
          active: false,
          windowId: 42,
        },
      ]),
      update: vi.fn(),
    },
    windows: {
      get: vi.fn(async () => ({ id: 42, state: "minimized", focused: false })),
      update: vi.fn(),
    },
    debugger: {
      getTargets: vi.fn(async () => [
        { id: "target-7", tabId: 7, attached: false },
        { id: "target-8", tabId: 8, attached: true },
      ]),
      attach: vi.fn(),
      sendCommand: vi.fn(),
    },
  };
  const run = vm.runInNewContext(source.slice(begin, end) + "\nhandleForwardCdpCommand", {
    chrome,
    tabs: new Map(),
    tabDiagnosticEvents: [],
    setTimeout,
    clearTimeout,
  });
  const result = await run({ params: { method: "Clawser.diagnosticSnapshot", params: {} } });
  expect(result.tabs).toEqual([
    {
      tabId: 7,
      targetId: "target-7",
      url: "https://qdd.test/a",
      discarded: true,
      autoDiscardable: false,
      frozen: false,
      status: "unloaded",
      active: true,
      windowId: 42,
      state: "minimized",
      focused: false,
      attached: false,
    },
    {
      tabId: 8,
      targetId: "target-8",
      url: "https://ywb.test/b",
      discarded: false,
      autoDiscardable: true,
      frozen: true,
      status: "complete",
      active: false,
      windowId: 42,
      state: "minimized",
      focused: false,
      attached: true,
    },
  ]);
  expect(chrome.tabs.update).not.toHaveBeenCalled();
  expect(chrome.windows.update).not.toHaveBeenCalled();
  expect(chrome.debugger.attach).not.toHaveBeenCalled();
  expect(chrome.debugger.sendCommand).not.toHaveBeenCalled();
});

it("does not choose one of two debugger targets for the same tab", async () => {
  const source = fs.readFileSync(
    new URL("../../chrome-extension/background.js", import.meta.url),
    "utf8",
  );
  const begin = source.indexOf("async function handleForwardCdpCommand("),
    end = source.indexOf("\nfunction onDebuggerEvent", begin);
  const chrome = {
    tabs: { query: async () => [{ id: 7, url: "https://qdd.test", windowId: 42 }] },
    windows: { get: async () => ({ state: "normal" }) },
    debugger: {
      getTargets: async () => [
        { id: "first", tabId: 7, attached: true },
        { id: "second", tabId: 7, attached: false },
      ],
    },
  };
  const run = vm.runInNewContext(source.slice(begin, end) + "\nhandleForwardCdpCommand", {
    chrome,
    tabs: new Map(),
    tabDiagnosticEvents: [],
    setTimeout,
    clearTimeout,
  });
  const result = await run({ params: { method: "Clawser.diagnosticSnapshot", params: {} } });
  expect(result.tabs[0]).toMatchObject({ targetId: null, targetMatch: "ambiguous" });
});
