import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

describe("build-macos-pkg.sh", () => {
  it("does not use pkill -f for tray shutdown in postinstall", () => {
    const script = fs.readFileSync(path.join(root, "scripts/build-macos-pkg.sh"), "utf8");

    expect(script).not.toContain("pkill -f");
    expect(script).toContain("pkill -x clawser-tray");
  });
});
