#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import module from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 12;
const MIN_NODE_VERSION = `${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`;

const ROOT_OPTION_ARITY = new Map([
  ["--dev", 0],
  ["--no-color", 0],
  ["--profile", 1],
  ["--log-level", 1],
]);

const here = path.dirname(fileURLToPath(import.meta.url));
const CLAWSER_STATE_DIRNAME = ".clawser";
const CLAWSER_CONFIG_FILENAME = "clawser.json";
const CLAWSER_DEFAULT_BROWSER_CONFIG = {
  enabled: true,
  defaultProfile: "chrome",
  ssrfPolicy: {
    dangerouslyAllowPrivateNetwork: true,
  },
  profiles: {
    chrome: {
      cdpUrl: "http://127.0.0.1:18792",
      driver: "extension",
      color: "#00AA00",
    },
  },
};

const parseNodeVersion = (rawVersion) => {
  const [majorRaw = "0", minorRaw = "0"] = rawVersion.split(".");
  return {
    major: Number(majorRaw),
    minor: Number(minorRaw),
  };
};

const isSupportedNodeVersion = (version) =>
  version.major > MIN_NODE_MAJOR ||
  (version.major === MIN_NODE_MAJOR && version.minor >= MIN_NODE_MINOR);

function ensureSupportedNodeVersion() {
  if (isSupportedNodeVersion(parseNodeVersion(process.versions.node))) {
    return;
  }

  process.stderr.write(
    `clawser: Node.js v${MIN_NODE_VERSION}+ is required (current: v${process.versions.node}).\n` +
      "If you use nvm, run:\n" +
      `  nvm install ${MIN_NODE_MAJOR}\n` +
      `  nvm use ${MIN_NODE_MAJOR}\n` +
      `  nvm alias default ${MIN_NODE_MAJOR}\n`,
  );
  process.exit(1);
}

const isModuleNotFoundError = (err) =>
  err && typeof err === "object" && "code" in err && err.code === "ERR_MODULE_NOT_FOUND";

async function installProcessWarningFilter() {
  for (const specifier of ["./dist/warning-filter.js", "./dist/warning-filter.mjs"]) {
    try {
      const mod = await import(specifier);
      if (typeof mod.installProcessWarningFilter === "function") {
        mod.installProcessWarningFilter();
        return;
      }
    } catch (err) {
      if (isModuleNotFoundError(err)) {
        continue;
      }
      throw err;
    }
  }
}

async function importCliEntry() {
  for (const specifier of ["./dist/entry.js", "./dist/entry.mjs"]) {
    try {
      await import(specifier);
      return;
    } catch (err) {
      if (isModuleNotFoundError(err)) {
        continue;
      }
      throw err;
    }
  }
  throw new Error("clawser: missing dist/entry.(m)js (build output).");
}

function takeValue(raw, next) {
  if (raw.includes("=")) {
    return { value: raw.split("=", 2)[1]?.trim() || null, consumedNext: false };
  }
  return { value: next?.trim() || null, consumedNext: Boolean(next) };
}

function profileEnvForArgs(args) {
  const env = { ...process.env };
  let profile = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg || arg === "--" || !arg.startsWith("-")) {
      break;
    }
    if (arg === "--dev") {
      profile = "dev";
      continue;
    }
    if (arg === "--profile" || arg.startsWith("--profile=")) {
      const { value, consumedNext } = takeValue(arg, args[i + 1]);
      if (consumedNext) {
        i += 1;
      }
      if (value) {
        profile = value;
      }
    }
  }
  const effectiveProfile = profile ?? env.OPENCLAW_PROFILE?.trim() ?? null;
  if (profile) {
    env.OPENCLAW_PROFILE = profile;
  }
  if (!env.OPENCLAW_STATE_DIR?.trim()) {
    const suffix =
      effectiveProfile && effectiveProfile.toLowerCase() !== "default" ? `-${effectiveProfile}` : "";
    env.OPENCLAW_STATE_DIR = path.join(os.homedir(), `${CLAWSER_STATE_DIRNAME}${suffix}`);
  }
  if (!env.OPENCLAW_CONFIG_PATH?.trim()) {
    env.OPENCLAW_CONFIG_PATH = path.join(env.OPENCLAW_STATE_DIR, CLAWSER_CONFIG_FILENAME);
  }
  if (effectiveProfile === "dev" && !env.OPENCLAW_GATEWAY_PORT?.trim()) {
    env.OPENCLAW_GATEWAY_PORT = "19001";
  }
  return env;
}

function stateDirForEnv(env) {
  return env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), CLAWSER_STATE_DIRNAME);
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function ensureClawserConfig(env) {
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (!configPath) {
    return;
  }

  const existing = fs.existsSync(configPath) ? readJsonFile(configPath) : {};
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    return;
  }

  let changed = false;
  const next = { ...existing };
  const browser =
    next.browser && typeof next.browser === "object" && !Array.isArray(next.browser)
      ? { ...next.browser }
      : {};
  if (!next.browser) {
    changed = true;
  }

  if (browser.enabled === undefined) {
    browser.enabled = CLAWSER_DEFAULT_BROWSER_CONFIG.enabled;
    changed = true;
  }
  if (!String(browser.defaultProfile ?? "").trim()) {
    browser.defaultProfile = CLAWSER_DEFAULT_BROWSER_CONFIG.defaultProfile;
    changed = true;
  }
  if (!browser.ssrfPolicy || typeof browser.ssrfPolicy !== "object" || Array.isArray(browser.ssrfPolicy)) {
    browser.ssrfPolicy = { ...CLAWSER_DEFAULT_BROWSER_CONFIG.ssrfPolicy };
    changed = true;
  }

  const profiles =
    browser.profiles && typeof browser.profiles === "object" && !Array.isArray(browser.profiles)
      ? { ...browser.profiles }
      : {};
  if (!profiles.chrome) {
    profiles.chrome = { ...CLAWSER_DEFAULT_BROWSER_CONFIG.profiles.chrome };
    browser.profiles = profiles;
    changed = true;
  }
  if (
    profiles.chrome &&
    typeof profiles.chrome === "object" &&
    !Array.isArray(profiles.chrome) &&
    profiles.chrome.driver !== "extension" &&
    String(profiles.chrome.cdpUrl ?? "").replace(/\/$/, "") ===
      CLAWSER_DEFAULT_BROWSER_CONFIG.profiles.chrome.cdpUrl
  ) {
    profiles.chrome = {
      ...profiles.chrome,
      driver: "extension",
      color: profiles.chrome.color ?? CLAWSER_DEFAULT_BROWSER_CONFIG.profiles.chrome.color,
    };
    browser.profiles = profiles;
    changed = true;
  }

  if (changed) {
    next.browser = browser;
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  }
}

function daemonPidPath(env) {
  return path.join(stateDirForEnv(env), "browser", "clawser-daemon.pid");
}

function readDaemonPid(env) {
  try {
    const pid = Number.parseInt(fs.readFileSync(daemonPidPath(env), "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function isRelayReachable(port = 18792) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 300);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/extension/status`, {
      signal: ctrl.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForRelay() {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await isRelayReachable()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function execFileQuiet(file, args, timeout = 1500) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true }, (error, stdout) => {
      resolve({ ok: !error, stdout: stdout ?? "" });
    });
  });
}

async function isAnyProcessRunning(names) {
  if (process.platform === "darwin") {
    for (const name of names) {
      if ((await execFileQuiet("pgrep", ["-x", name])).ok) {
        return true;
      }
    }
    return false;
  }

  if (process.platform === "win32") {
    for (const name of names) {
      const result = await execFileQuiet("tasklist.exe", ["/FI", `IMAGENAME eq ${name}`, "/NH"], 2500);
      if (result.stdout.toLowerCase().includes(name.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  for (const name of names) {
    if ((await execFileQuiet("pgrep", ["-x", name])).ok) {
      return true;
    }
  }
  return false;
}

function spawnDetached(file, args) {
  try {
    const child = spawn(file, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function ensureChromeHasBlankTab() {
  if (process.env.CLAWSER_SKIP_CHROME_BOOTSTRAP?.trim()) {
    return;
  }

  const chromeProcessNames =
    process.platform === "darwin"
      ? ["Google Chrome", "Google Chrome Canary"]
      : process.platform === "win32"
        ? ["chrome.exe"]
        : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"];

  if (await isAnyProcessRunning(chromeProcessNames)) {
    return;
  }

  if (process.platform === "darwin") {
    if (spawnDetached("open", ["-a", "Google Chrome", "about:blank"])) {
      return;
    }
    spawnDetached("open", ["-a", "Google Chrome Canary", "about:blank"]);
    return;
  }

  if (process.platform === "win32") {
    spawnDetached("cmd.exe", ["/d", "/s", "/c", "start", "", "chrome", "about:blank"]);
    return;
  }

  for (const command of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"]) {
    if (spawnDetached(command, ["about:blank"])) {
      return;
    }
  }
}

async function ensureDaemon(args) {
  const env = profileEnvForArgs(args);
  const existing = readDaemonPid(env);
  if (existing && isProcessAlive(existing) && (await isRelayReachable())) {
    return;
  }

  fs.mkdirSync(path.dirname(daemonPidPath(env)), { recursive: true });
  const child = spawn(process.execPath, [path.join(here, "clawser.mjs"), "__daemon"], {
    cwd: here,
    detached: true,
    env,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  if (child.pid) {
    fs.writeFileSync(daemonPidPath(env), `${child.pid}\n`);
  }
  if (!(await waitForRelay())) {
    throw new Error("clawser browser relay did not become reachable at http://127.0.0.1:18792/");
  }
}

function stopDaemon(args) {
  const env = profileEnvForArgs(args);
  const pid = readDaemonPid(env);
  if (!pid) {
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // already stopped
  }
  try {
    fs.rmSync(daemonPidPath(env), { force: true });
  } catch {
    // ignore
  }
}

function browserShortcutArgs(args) {
  if (args[0] === "__daemon") {
    return args;
  }
  if (args[0] === "browser") {
    return args;
  }

  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (!arg || arg === "--" || !arg.startsWith("-")) {
      break;
    }
    const [name] = arg.split("=", 1);
    const arity = ROOT_OPTION_ARITY.get(name);
    if (arity === undefined) {
      break;
    }
    index += 1;
    if (arity > 0 && !arg.includes("=")) {
      index += arity;
    }
  }

  return [...args.slice(0, index), "browser", ...args.slice(index)];
}

function commandName(args) {
  const normalized = browserShortcutArgs(args);
  const browserIndex = normalized.indexOf("browser");
  if (browserIndex < 0) {
    return null;
  }
  for (let i = browserIndex + 1; i < normalized.length; i += 1) {
    const arg = normalized[i];
    if (!arg || arg === "--") {
      return null;
    }
    if (arg.startsWith("-")) {
      if (
        ["--browser-profile", "--url", "--token", "--timeout"].includes(arg) &&
        !arg.includes("=")
      ) {
        i += 1;
      }
      continue;
    }
    return arg;
  }
  return null;
}

const rawArgs = process.argv.slice(2);
ensureSupportedNodeVersion();
if (module.enableCompileCache && !process.env.NODE_DISABLE_COMPILE_CACHE) {
  try {
    module.enableCompileCache();
  } catch {
    // Best-effort only.
  }
}
await installProcessWarningFilter();

Object.assign(process.env, profileEnvForArgs(rawArgs));
ensureClawserConfig(process.env);

if (rawArgs[0] === "__daemon") {
  await import("./dist/daemon-entry.js");
}

if (commandName(rawArgs) === "start") {
  await ensureDaemon(rawArgs);
  await ensureChromeHasBlankTab();
}

process.argv = [
  process.argv[0] ?? "node",
  new URL(import.meta.url).pathname,
  ...browserShortcutArgs(rawArgs),
];
process.env.OPENCLAW_NO_RESPAWN = "1";

await importCliEntry();

if (globalThis.__OPENCLAW_ENTRY_RUN_PROMISE) {
  await globalThis.__OPENCLAW_ENTRY_RUN_PROMISE;
  if (commandName(rawArgs) === "stop") {
    stopDaemon(rawArgs);
  }
  process.exit(process.exitCode ?? 0);
}
