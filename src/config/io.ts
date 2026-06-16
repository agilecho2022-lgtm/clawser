import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSON5 from "json5";
import { loadDotEnv } from "../infra/dotenv.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { VERSION } from "../version.js";
import { resolveConfigPath, resolveDefaultConfigCandidates, resolveStateDir } from "./paths.js";
import { applyConfigOverrides } from "./runtime-overrides.js";
import type { ConfigFileSnapshot, LegacyConfigIssue, ClawserConfig } from "./types.js";

export type ParseConfigJson5Result = { ok: true; parsed: unknown } | { ok: false; error: string };
export type ConfigWriteOptions = {
  unsetPaths?: string[][];
};

export type ReadConfigFileSnapshotForWriteResult = {
  snapshot: ConfigFileSnapshot;
  writeOptions: ConfigWriteOptions;
};

export type RuntimeConfigSnapshotRefreshParams = {
  sourceConfig: ClawserConfig;
};

export type RuntimeConfigSnapshotRefreshHandler = {
  refresh: (params: RuntimeConfigSnapshotRefreshParams) => boolean | Promise<boolean>;
  clearOnRefreshFailure?: () => void;
};

export class ConfigRuntimeRefreshError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ConfigRuntimeRefreshError";
  }
}

export type ConfigIoDeps = {
  fs?: typeof fs;
  json5?: typeof JSON5;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  configPath?: string;
  logger?: Pick<typeof console, "error" | "warn">;
};

export function parseConfigJson5(
  raw: string,
  json5: { parse: (value: string) => unknown } = JSON5,
): ParseConfigJson5Result {
  try {
    return { ok: true, parsed: json5.parse(raw) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function hashConfigRaw(raw: string | null): string {
  return crypto
    .createHash("sha256")
    .update(raw ?? "")
    .digest("hex");
}

export function resolveConfigSnapshotHash(snapshot: {
  hash?: string;
  raw?: string | null;
}): string | null {
  if (typeof snapshot.hash === "string" && snapshot.hash.trim()) {
    return snapshot.hash.trim();
  }
  return typeof snapshot.raw === "string" ? hashConfigRaw(snapshot.raw) : null;
}

function coerceConfig(value: unknown): ClawserConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as ClawserConfig;
}

function cloneConfig(cfg: ClawserConfig): ClawserConfig {
  return structuredClone(cfg);
}

function normalizeDeps(overrides: ConfigIoDeps = {}): Required<ConfigIoDeps> {
  const env = overrides.env ?? process.env;
  return {
    fs: overrides.fs ?? fs,
    json5: overrides.json5 ?? JSON5,
    env,
    homedir: overrides.homedir ?? (() => resolveRequiredHomeDir(env, os.homedir)),
    configPath: overrides.configPath ?? "",
    logger: overrides.logger ?? console,
  };
}

function resolveConfigPathForDeps(deps: Required<ConfigIoDeps>): string {
  if (deps.configPath) {
    return deps.configPath;
  }
  return resolveConfigPath(deps.env, resolveStateDir(deps.env, deps.homedir), deps.homedir);
}

function maybeLoadDotEnvForConfig(env: NodeJS.ProcessEnv): void {
  if (env === process.env) {
    loadDotEnv({ quiet: true });
  }
}

function applyInlineEnvVars(cfg: ClawserConfig, env: NodeJS.ProcessEnv): void {
  const vars = cfg.env?.vars;
  if (!vars) {
    return;
  }
  for (const [key, value] of Object.entries(vars)) {
    if (typeof value === "string" && env[key] === undefined) {
      env[key] = value;
    }
  }
}

function resolveEnvRefs(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/gi, (match, name: string) => env[name] ?? match);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => resolveEnvRefs(entry, env));
  }
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      next[key] = resolveEnvRefs(child, env);
    }
    return next;
  }
  return value;
}

function stampConfigVersion(cfg: ClawserConfig): ClawserConfig {
  return {
    ...cfg,
    meta: {
      ...cfg.meta,
      lastTouchedVersion: VERSION,
      lastTouchedAt: new Date().toISOString(),
    },
  };
}

function createSnapshot(params: {
  configPath: string;
  raw: string | null;
  parsed: unknown;
  config: ClawserConfig;
  valid: boolean;
  issues?: { path: string; message: string }[];
  legacyIssues?: LegacyConfigIssue[];
}): ConfigFileSnapshot {
  return {
    path: params.configPath,
    exists: params.raw !== null,
    raw: params.raw,
    parsed: params.parsed,
    resolved: params.config,
    valid: params.valid,
    config: params.config,
    hash: hashConfigRaw(params.raw),
    issues: params.issues ?? [],
    warnings: [],
    legacyIssues: params.legacyIssues ?? [],
  };
}

let configCache: { path: string; hash: string; config: ClawserConfig } | null = null;
let runtimeConfigSnapshot: ClawserConfig | null = null;
let runtimeConfigSourceSnapshot: ClawserConfig | null = null;
let runtimeConfigRefreshHandler: RuntimeConfigSnapshotRefreshHandler | null = null;

export function createConfigIO(overrides: ConfigIoDeps = {}) {
  const deps = normalizeDeps(overrides);
  const requestedConfigPath = resolveConfigPathForDeps(deps);
  const candidatePaths = deps.configPath
    ? [requestedConfigPath]
    : resolveDefaultConfigCandidates(deps.env, deps.homedir);
  const configPath =
    candidatePaths.find((candidate) => deps.fs.existsSync(candidate)) ?? requestedConfigPath;

  function readRawConfig(): { raw: string | null; parse: ParseConfigJson5Result } {
    if (!deps.fs.existsSync(configPath)) {
      return { raw: null, parse: { ok: true, parsed: {} } };
    }
    const raw = deps.fs.readFileSync(configPath, "utf-8");
    return { raw, parse: parseConfigJson5(raw, deps.json5) };
  }

  function normalizeConfig(parsed: unknown): ClawserConfig {
    const cfg = coerceConfig(parsed);
    applyInlineEnvVars(cfg, deps.env);
    return applyConfigOverrides(coerceConfig(resolveEnvRefs(cfg, deps.env)));
  }

  function loadConfig(): ClawserConfig {
    maybeLoadDotEnvForConfig(deps.env);
    const { raw, parse } = readRawConfig();
    const hash = hashConfigRaw(raw);
    if (configCache && configCache.path === configPath && configCache.hash === hash) {
      return cloneConfig(configCache.config);
    }
    if (!parse.ok) {
      throw new Error(`Config parse failed: ${configPath}: ${parse.error}`);
    }
    const config = normalizeConfig(parse.parsed);
    configCache = { path: configPath, hash, config: cloneConfig(config) };
    return config;
  }

  async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
    maybeLoadDotEnvForConfig(deps.env);
    const { raw, parse } = readRawConfig();
    if (!parse.ok) {
      return createSnapshot({
        configPath,
        raw,
        parsed: null,
        config: {},
        valid: false,
        issues: [{ path: "", message: parse.error }],
      });
    }
    const config = normalizeConfig(parse.parsed);
    return createSnapshot({
      configPath,
      raw,
      parsed: parse.parsed,
      config,
      valid: true,
    });
  }

  async function readConfigFileSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
    return {
      snapshot: await readConfigFileSnapshot(),
      writeOptions: {},
    };
  }

  async function writeConfigFile(cfg: ClawserConfig, _options: ConfigWriteOptions = {}) {
    clearConfigCache();
    const next = stampConfigVersion(cfg);
    await deps.fs.promises.mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
    const raw = `${JSON.stringify(next, null, 2)}\n`;
    await deps.fs.promises.writeFile(configPath, raw, { encoding: "utf-8", mode: 0o600 });
    configCache = { path: configPath, hash: hashConfigRaw(raw), config: cloneConfig(next) };
  }

  function readConfigFileSnapshotSync(): ConfigFileSnapshot {
    maybeLoadDotEnvForConfig(deps.env);
    const { raw, parse } = readRawConfig();
    if (!parse.ok) {
      return createSnapshot({
        configPath,
        raw,
        parsed: null,
        config: {},
        valid: false,
        issues: [{ path: "", message: parse.error }],
      });
    }
    const config = normalizeConfig(parse.parsed);
    return createSnapshot({
      configPath,
      raw,
      parsed: parse.parsed,
      config,
      valid: true,
    });
  }

  return {
    loadConfig,
    readConfigFileSnapshot,
    readConfigFileSnapshotForWrite,
    readConfigFileSnapshotSync,
    writeConfigFile,
  };
}

export function clearConfigCache(): void {
  configCache = null;
}

export function clearRuntimeConfigSnapshot(): void {
  runtimeConfigSnapshot = null;
  runtimeConfigSourceSnapshot = null;
}

export function getRuntimeConfigSnapshot(): ClawserConfig | null {
  return runtimeConfigSnapshot ? cloneConfig(runtimeConfigSnapshot) : null;
}

export function getRuntimeConfigSourceSnapshot(): ClawserConfig | null {
  return runtimeConfigSourceSnapshot ? cloneConfig(runtimeConfigSourceSnapshot) : null;
}

export function projectConfigOntoRuntimeSourceSnapshot(cfg: ClawserConfig): ClawserConfig {
  return cfg;
}

export function setRuntimeConfigSnapshot(cfg: ClawserConfig | null): void {
  runtimeConfigSnapshot = cfg ? cloneConfig(cfg) : null;
  runtimeConfigSourceSnapshot = cfg ? cloneConfig(cfg) : null;
}

export function setRuntimeConfigSnapshotRefreshHandler(
  handler: RuntimeConfigSnapshotRefreshHandler | null,
): void {
  runtimeConfigRefreshHandler = handler;
}

export async function refreshRuntimeConfigSnapshot(sourceConfig: ClawserConfig): Promise<boolean> {
  if (!runtimeConfigRefreshHandler) {
    setRuntimeConfigSnapshot(sourceConfig);
    return true;
  }
  const ok = await runtimeConfigRefreshHandler.refresh({ sourceConfig });
  if (ok) {
    setRuntimeConfigSnapshot(sourceConfig);
  } else {
    runtimeConfigRefreshHandler.clearOnRefreshFailure?.();
  }
  return ok;
}

export function loadConfig(): ClawserConfig {
  return createConfigIO().loadConfig();
}

export function readBestEffortConfig(): ClawserConfig {
  try {
    return loadConfig();
  } catch {
    return {};
  }
}

export async function readConfigFileSnapshot(): Promise<ConfigFileSnapshot> {
  return await createConfigIO().readConfigFileSnapshot();
}

export async function readConfigFileSnapshotForWrite(): Promise<ReadConfigFileSnapshotForWriteResult> {
  return await createConfigIO().readConfigFileSnapshotForWrite();
}

export async function writeConfigFile(
  cfg: ClawserConfig,
  options: ConfigWriteOptions = {},
): Promise<void> {
  await createConfigIO().writeConfigFile(cfg, options);
}
