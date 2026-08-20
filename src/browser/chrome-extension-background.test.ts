import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function extensionPath(file: string): string {
  const assetPath = resolve(process.cwd(), "assets/chrome-extension", file);
  return existsSync(assetPath) ? assetPath : resolve(process.cwd(), "chrome-extension", file);
}

function readBackgroundWorker(): string {
  return readFileSync(extensionPath("background.js"), "utf8");
}

describe("chrome extension background worker", () => {
  it("allows Target.createTarget before requiring an attached tab", () => {
    const source = readBackgroundWorker();

    expect(source.indexOf("method === 'Target.createTarget'")).toBeGreaterThanOrEqual(0);
    expect(source.indexOf("method === 'Clawser.attachActiveTab'")).toBeGreaterThanOrEqual(0);
    expect(source.indexOf("if (!tabId) throw new Error")).toBeGreaterThanOrEqual(0);
    expect(source.indexOf("method === 'Target.createTarget'")).toBeLessThan(
      source.indexOf("if (!tabId) throw new Error"),
    );
    expect(source.indexOf("method === 'Clawser.attachActiveTab'")).toBeLessThan(
      source.indexOf("if (!tabId) throw new Error"),
    );
  });

  it("implements active-tab attach via chrome.tabs.query and attachTab", () => {
    const source = readBackgroundWorker();
    const attachStart = source.indexOf("method === 'Clawser.attachActiveTab'");
    const attachEnd = source.indexOf("const bySession", attachStart);
    const attachBlock = source.slice(attachStart, attachEnd);

    expect(attachStart).toBeGreaterThanOrEqual(0);
    expect(attachEnd).toBeGreaterThan(attachStart);
    expect(attachBlock).toContain("chrome.tabs.query({ active: true, currentWindow: true })");
    expect(attachBlock).toContain("await ensureRelayConnection()");
    expect(attachBlock).toContain("await reannounceAttachedTabs()");
    expect(attachBlock).toContain("await attachTabForRelay(tab)");
  });

  it("implements URL and all-tab attach by querying Chrome tabs", () => {
    const source = readBackgroundWorker();
    const attachStart = source.indexOf("method === 'Clawser.attachTabs'");
    const attachEnd = source.indexOf("const bySession", attachStart);
    const attachBlock = source.slice(attachStart, attachEnd);

    expect(attachStart).toBeGreaterThanOrEqual(0);
    expect(attachEnd).toBeGreaterThan(attachStart);
    expect(attachBlock).toContain("chrome.tabs.query({})");
    expect(attachBlock).toContain("urlContains");
    expect(attachBlock).toContain("await attachTabForRelay(tab)");
    expect(source).toContain("const attached = await attachTab(tab.id)");
  });

  it("auto-attaches tabs opened by an already attached tab", () => {
    const source = readBackgroundWorker();
    const helperStart = source.indexOf("async function autoAttachOpenedTab");
    const helperEnd = source.indexOf("async function connectOrToggleForActiveTab", helperStart);
    const helperBlock = source.slice(helperStart, helperEnd);
    const listenerStart = source.indexOf("chrome.tabs.onCreated.addListener");

    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(helperEnd).toBeGreaterThan(helperStart);
    expect(listenerStart).toBeGreaterThanOrEqual(0);
    expect(source).toContain(
      "chrome.tabs.onCreated.addListener((tab) => void whenReady(() => autoAttachOpenedTab(tab)))",
    );
    expect(helperBlock).toContain("openerTabId");
    expect(helperBlock).toContain("tabs.get(openerTabId)?.state !== 'connected'");
    expect(helperBlock).toContain("await attachTabForRelay");
    expect(helperBlock).toContain("await reannounceAttachedTabs()");
  });

  it("connects the relay on startup before checking for attached tabs", () => {
    const source = readBackgroundWorker();
    const initStart = source.indexOf("initPromise.then(() => {");
    const initEnd = source.indexOf("// Shared gate", initStart);
    const initBlock = source.slice(initStart, initEnd);

    expect(initStart).toBeGreaterThanOrEqual(0);
    expect(initEnd).toBeGreaterThan(initStart);
    expect(initBlock.indexOf("ensureRelayConnection().then")).toBeGreaterThanOrEqual(0);
    expect(initBlock.indexOf("if (tabs.size > 0)")).toBeGreaterThan(
      initBlock.indexOf("ensureRelayConnection().then"),
    );
  });
});
