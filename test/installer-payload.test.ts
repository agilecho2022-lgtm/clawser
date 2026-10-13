import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("builds only portable browser components and replaces a stale desktop payload", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "clawser-payload-test-"));
  tempDirs.push(fixture);
  function write(rel: string, content: string) {
    const file = path.join(fixture, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  for (const rel of [
    "scripts/build-installer-payload.mjs",
    "scripts/verify-portable-node-modules.mjs",
  ]) {
    write(rel, fs.readFileSync(path.join(root, rel), "utf8"));
  }
  for (const rel of [
    "clawser.mjs",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "dist/entry.js",
    "chrome-extension/background.js",
    "installer/chrome-extension-install.html",
    "README.md",
    "README_ZH.md",
    "LICENSE",
  ]) {
    write(rel, `fixture: ${rel}\n`);
  }
  write("package.json", '{"name":"clawser","version":"1.0.0"}\n');
  // Existing desktop outputs must never leak into the rebuilt cache.
  write("dist-tray/clawser-helper", "obsolete executable");
  write("tray/scripts/build-macos-app.sh", '#!/bin/sh\nmkdir -p "$1"\n');
  write(
    "bin/install-fixture.cjs",
    `const fs = require("node:fs");
fs.writeFileSync("install-args.json", JSON.stringify(process.argv.slice(2)));
for (const name of ["playwright", "playwright-core"]) {
  fs.mkdirSync("node_modules/" + name, { recursive: true });
  fs.writeFileSync("node_modules/" + name + "/package.json", JSON.stringify({ name }));
}
`,
  );
  write("bin/pnpm", '#!/bin/sh\nexec node "$(dirname "$0")/install-fixture.cjs" "$@"\n');
  write("bin/pnpm.cmd", '@echo off\r\nnode "%~dp0install-fixture.cjs" %*\r\n');
  fs.chmodSync(path.join(fixture, "bin/pnpm"), 0o755);

  const outDir = path.join(fixture, "payload");
  for (const skipMacOSApp of ["0", "1"]) {
    write("payload/Clawser Tray.app/obsolete", "stale app");
    write("payload/tray/obsolete", "stale executable");
    const result = spawnSync(
      process.execPath,
      [path.join(fixture, "scripts/build-installer-payload.mjs"), outDir],
      {
        cwd: fixture,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${path.join(fixture, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
          CLAWSER_SKIP_BUILD: "1",
          CLAWSER_SKIP_MACOS_APP: skipMacOSApp,
        },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(outDir, "tray"))).toBe(false);
    expect(fs.existsSync(path.join(outDir, "Clawser Tray.app"))).toBe(false);
    for (const rel of [
      "clawser.mjs",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "dist/entry.js",
      "chrome-extension/background.js",
      "README.md",
      "README_ZH.md",
      "LICENSE",
    ]) {
      expect(fs.readFileSync(path.join(outDir, rel))).toEqual(
        fs.readFileSync(path.join(fixture, rel)),
      );
    }
    expect(fs.readFileSync(path.join(outDir, "chrome-extension-install.html"))).toEqual(
      fs.readFileSync(path.join(fixture, "installer/chrome-extension-install.html")),
    );
    expect(JSON.parse(fs.readFileSync(path.join(outDir, "install-args.json"), "utf8"))).toEqual([
      "install",
      "--prod",
      "--frozen-lockfile",
    ]);
    for (const name of ["playwright", "playwright-core"]) {
      expect(fs.existsSync(path.join(outDir, "node_modules", name, "package.json"))).toBe(true);
    }
    expect(fs.readFileSync(path.join(outDir, "INSTALL.txt"), "utf8")).toContain("clawser start");
  }
});
