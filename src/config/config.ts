export {
  clearConfigCache,
  ConfigRuntimeRefreshError,
  clearRuntimeConfigSnapshot,
  createConfigIO,
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
  projectConfigOntoRuntimeSourceSnapshot,
  loadConfig,
  readBestEffortConfig,
  parseConfigJson5,
  readConfigFileSnapshot,
  readConfigFileSnapshotForWrite,
  resolveConfigSnapshotHash,
  setRuntimeConfigSnapshotRefreshHandler,
  setRuntimeConfigSnapshot,
  writeConfigFile,
} from "./io.js";
export * from "./paths.js";
export * from "./runtime-overrides.js";
export * from "./types.js";
import type { ClawserConfig } from "./types.js";

export function validateConfigObjectRaw(parsed: unknown): {
  ok: true;
  config: ClawserConfig;
  issues: [];
  warnings: [];
} {
  return {
    ok: true,
    config:
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as ClawserConfig)
        : {},
    issues: [],
    warnings: [],
  };
}

export const validateConfigObject = validateConfigObjectRaw;
export const validateConfigObjectRawWithPlugins = validateConfigObjectRaw;
export const validateConfigObjectWithPlugins = validateConfigObjectRaw;
