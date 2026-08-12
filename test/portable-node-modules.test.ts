import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const script = path.join(root, "scripts", "verify-portable-node-modules.mjs");
const tempDirs: string[] = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clawser-node-modules-test-"));
  tempDirs.push(dir);
  return dir;
}

function runVerifier(payloadDir: string) {
  return spawnSync(process.execPath, [script, payloadDir], {
    cwd: root,
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("verify-portable-node-modules.mjs", () => {
  it("rejects absolute symlinks under node_modules", () => {
    const payloadDir = makeTempDir();
    const targetDir = makeTempDir();
    const depDir = path.join(payloadDir, "node_modules", ".pnpm", "pkg@1.0.0", "node_modules");
    fs.mkdirSync(depDir, { recursive: true });
    fs.symlinkSync(targetDir, path.join(depDir, "dep"));

    const result = runVerifier(payloadDir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("absolute symlink");
    expect(result.stderr).toContain("node_modules/.pnpm/pkg@1.0.0/node_modules/dep");
  });

  it("accepts relative symlinks under node_modules", () => {
    const payloadDir = makeTempDir();
    const storeDir = path.join(payloadDir, "node_modules", ".pnpm", "dep@1.0.0", "node_modules");
    const depDir = path.join(storeDir, "dep");
    fs.mkdirSync(depDir, { recursive: true });
    fs.symlinkSync(
      ".pnpm/dep@1.0.0/node_modules/dep",
      path.join(payloadDir, "node_modules", "dep"),
    );

    const result = runVerifier(payloadDir);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });
});
