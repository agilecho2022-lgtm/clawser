#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.resolve(process.argv[2] ?? path.join(root, "dist-installer", "Clawser"));

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: opts.cwd ?? root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: opts.env ?? process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function copyRequired(srcRel, destRel = srcRel) {
  const src = path.join(root, srcRel);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing required installer input: ${srcRel}`);
  }
  fs.cpSync(src, path.join(outDir, destRel), { recursive: true });
}

function copyOptional(srcRel, destRel = srcRel) {
  const src = path.join(root, srcRel);
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(outDir, destRel), { recursive: true });
  }
}

function writeInstallNote() {
  const text = [
    "Clawser installer payload",
    "",
    "Chrome extension manual install:",
    "1. Open chrome-extension-install.html.",
    "2. Open chrome://extensions in Google Chrome.",
    "3. Enable Developer mode.",
    "4. Choose Load unpacked and select the chrome-extension folder in this directory.",
    "5. On the Clawser Browser Relay options page, keep port 18792 and click Save.",
    "6. Run clawser start to start the local relay.",
    "7. Click the extension icon on the tab you want to control.",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "INSTALL.txt"), text);
}

if (process.env.CLAWSER_SKIP_BUILD !== "1") {
  run("pnpm", ["build"]);
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

copyRequired("clawser.mjs");
copyRequired("package.json");
copyRequired("pnpm-lock.yaml");
copyRequired("pnpm-workspace.yaml");
copyRequired("dist");
copyRequired("chrome-extension");
copyRequired("installer/chrome-extension-install.html", "chrome-extension-install.html");
copyOptional("README.md");
copyOptional("README_ZH.md");
copyOptional("LICENSE");
writeInstallNote();

run("pnpm", ["install", "--prod", "--frozen-lockfile"], { cwd: outDir });
run(process.execPath, [path.join(root, "scripts", "verify-portable-node-modules.mjs"), outDir]);

console.log(outDir);
