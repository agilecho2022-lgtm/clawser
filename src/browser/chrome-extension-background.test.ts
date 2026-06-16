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
    expect(source.indexOf("if (!tabId) throw new Error")).toBeGreaterThanOrEqual(0);
    expect(source.indexOf("method === 'Target.createTarget'")).toBeLessThan(
      source.indexOf("if (!tabId) throw new Error"),
    );
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
