export * from "./types.browser.js";
export * from "./types.gateway.js";
export * from "./types.secrets.js";
export * from "./types.cli.js";

import type { BrowserConfig } from "./types.browser.js";
import type { CliConfig } from "./types.cli.js";
import type { GatewayConfig } from "./types.gateway.js";
import type { SecretsConfig } from "./types.secrets.js";

export type ClawserConfig = {
  meta?: {
    lastTouchedVersion?: string;
    lastTouchedAt?: string;
  };
  env?: {
    shellEnv?: {
      enabled?: boolean;
      timeoutMs?: number;
    };
    vars?: Record<string, string>;
    [key: string]:
      | string
      | Record<string, string>
      | { enabled?: boolean; timeoutMs?: number }
      | undefined;
  };
  cli?: CliConfig;
  logging?: {
    level?: "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";
    file?: string;
    maxFileBytes?: number;
    consoleLevel?: "silent" | "fatal" | "error" | "warn" | "info" | "debug" | "trace";
    consoleStyle?: string;
    redactSensitive?: string;
    redactPatterns?: string[];
  };
  browser?: BrowserConfig;
  gateway?: GatewayConfig;
  secrets?: SecretsConfig;
  hooks?: {
    enabled?: boolean;
    token?: string;
  };
};

export type ConfigValidationIssue = {
  path: string;
  message: string;
  allowedValues?: string[];
  allowedValuesHiddenCount?: number;
};

export type LegacyConfigIssue = {
  path: string;
  message: string;
};

export type ConfigFileSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  resolved: ClawserConfig;
  valid: boolean;
  config: ClawserConfig;
  hash?: string;
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
  legacyIssues: LegacyConfigIssue[];
};
