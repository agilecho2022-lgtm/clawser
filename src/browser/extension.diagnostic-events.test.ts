import fs from "node:fs";
import vm from "node:vm";
import { expect, it } from "vitest";

function recorder(send: (row: Record<string, unknown>) => void = () => {}) {
  const source = fs.readFileSync(
    new URL("../../chrome-extension/background.js", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function recordTabDiagnostic(");
  // Missing recorder is the expected RED, rather than a VM syntax error.
  expect(start, "native tab events must be recorded at event time").toBeGreaterThanOrEqual(0);
  const end = source.indexOf("\nasync function validateAttachedTab", start);
  const tabs = new Map([[7, { targetId: "old-target", sessionId: "s7" }]]),
    events: Record<string, unknown>[] = [];
  const chrome = {
    tabs: {
      get: async (id: number) => ({
        id,
        url: "https://qdd.test",
        discarded: true,
        frozen: false,
        status: "unloaded",
        autoDiscardable: true,
        windowId: 42,
        active: false,
      }),
    },
    windows: { get: async () => ({ state: "minimized", focused: false }) },
  };
  const run = vm.runInNewContext(source.slice(start, end) + "\nrecordTabDiagnostic", {
    chrome,
    tabs,
    tabDiagnosticEvents: events,
    workerDiagnostic: { startedAt: 100, startSequence: 2 },
    sendToRelay: (message: { params: Record<string, unknown> }) => send(message.params),
    setTimeout,
    clearTimeout,
    Date,
  });
  return { run, events, chrome };
}

it("records the native discarded flag synchronously before any later snapshot or connection failure", async () => {
  const sent: Record<string, unknown>[] = [];
  const f = recorder((row) => sent.push(row));
  const tab = {
    id: 17,
    url: "https://qdd.test",
    discarded: true,
    frozen: false,
    status: "unloaded",
    autoDiscardable: true,
    windowId: 42,
    active: false,
  };
  const pending = f.run("updated", tab, { targetId: "old-target", removedTabId: 7 });
  tab.discarded = false;
  expect(sent[0]).toMatchObject({
    event: "updated",
    tabId: 17,
    discarded: true,
    status: "unloaded",
    targetId: "old-target",
    removedTabId: 7,
    stage: "event",
    identitySource: "attachment_projection",
  });
  expect(sent[0].eventAt).toBeTruthy();
  expect(sent[0].observedAt).toBe(sent[0].eventAt);
  await pending;
  expect(sent.at(-1)).toMatchObject({ state: "minimized", focused: false });
});
it("retains bounded evidence when the Relay is gone without waking or changing a tab", async () => {
  const f = recorder(() => {
    throw Error("Relay closed");
  });
  for (let i = 0; i < 105; i++) {
    await f.run("updated", { id: 7, discarded: true, windowId: 42 }, { targetId: "old-target" });
  }
  expect(f.events.length).toBeLessThanOrEqual(100);
  expect(f.events.at(-1)).toMatchObject({ discarded: true, targetId: "old-target" });
});
it("does not label an asynchronous replacement observation as event-time state", async () => {
  const f = recorder();
  await f.run("replaced", { id: 17 }, { targetId: "old-target", removedTabId: 7 });
  expect(f.events[0]).toMatchObject({
    stage: "event",
    discarded: null,
    targetId: "old-target",
    removedTabId: 7,
  });
  expect(f.events.at(-1)).toMatchObject({ stage: "observation", discarded: true });
});

it("unavailable native window query ends within the existing two-second diagnostic budget", async () => {
  const f = recorder();
  f.chrome.windows.get = async () => new Promise(() => {});
  const start = Date.now();
  await f.run("updated", { id: 7, discarded: true, windowId: 42 });
  expect(Date.now() - start).toBeLessThan(2400);
  expect(f.events[0]).toMatchObject({ discarded: true, stage: "event" });
  expect(f.events.at(-1)?.observationError).toBe("event snapshot timeout");
});
