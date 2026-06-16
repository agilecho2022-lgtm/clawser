import crypto from "node:crypto";
import type { GatewayAuthConfig, ClawserConfig } from "../config/config.js";
import { writeConfigFile } from "../config/config.js";
import { hasConfiguredSecretInput } from "../config/types.secrets.js";
import { assertExplicitGatewayAuthModeWhenBothConfigured } from "./auth-mode-policy.js";
import { resolveGatewayAuth, type ResolvedGatewayAuth } from "./auth.js";
import {
  hasGatewayPasswordEnvCandidate,
  hasGatewayTokenEnvCandidate,
  readGatewayTokenEnv,
} from "./credentials.js";
import { resolveRequiredConfiguredSecretRefInputString } from "./resolve-configured-secret-input-string.js";

export function mergeGatewayAuthConfig(
  base?: GatewayAuthConfig,
  override?: GatewayAuthConfig,
): GatewayAuthConfig {
  const merged: GatewayAuthConfig = { ...base };
  if (!override) {
    return merged;
  }
  if (override.mode !== undefined) {
    merged.mode = override.mode;
  }
  if (override.token !== undefined) {
    merged.token = override.token;
  }
  if (override.password !== undefined) {
    merged.password = override.password;
  }
  return merged;
}

function resolveGatewayAuthFromConfig(params: {
  cfg: ClawserConfig;
  env: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
}) {
  return resolveGatewayAuth({
    authConfig: params.cfg.gateway?.auth,
    authOverride: params.authOverride,
    env: params.env,
  });
}

function shouldPersistGeneratedToken(params: {
  persistRequested: boolean;
  resolvedAuth: ResolvedGatewayAuth;
}): boolean {
  if (!params.persistRequested) {
    return false;
  }

  // Keep CLI/runtime mode overrides ephemeral: startup should not silently
  // mutate durable auth policy when mode was chosen by an override flag.
  if (params.resolvedAuth.modeSource === "override") {
    return false;
  }

  return true;
}

function hasGatewayTokenCandidate(params: {
  cfg: ClawserConfig;
  env: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
}): boolean {
  const envToken = readGatewayTokenEnv(params.env);
  if (envToken) {
    return true;
  }
  if (
    typeof params.authOverride?.token === "string" &&
    params.authOverride.token.trim().length > 0
  ) {
    return true;
  }
  return hasConfiguredSecretInput(params.cfg.gateway?.auth?.token, params.cfg.secrets?.defaults);
}

function hasGatewayTokenOverrideCandidate(params: { authOverride?: GatewayAuthConfig }): boolean {
  return Boolean(
    typeof params.authOverride?.token === "string" && params.authOverride.token.trim().length > 0,
  );
}

function hasGatewayPasswordOverrideCandidate(params: {
  env: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
}): boolean {
  if (hasGatewayPasswordEnvCandidate(params.env)) {
    return true;
  }
  return Boolean(
    typeof params.authOverride?.password === "string" &&
    params.authOverride.password.trim().length > 0,
  );
}

function shouldResolveGatewayTokenSecretRef(params: {
  cfg: ClawserConfig;
  env: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
}): boolean {
  if (hasGatewayTokenOverrideCandidate({ authOverride: params.authOverride })) {
    return false;
  }
  if (hasGatewayTokenEnvCandidate(params.env)) {
    return false;
  }
  const explicitMode = params.authOverride?.mode ?? params.cfg.gateway?.auth?.mode;
  if (explicitMode === "token") {
    return true;
  }
  if (explicitMode === "password" || explicitMode === "none") {
    return false;
  }

  if (hasGatewayPasswordOverrideCandidate(params)) {
    return false;
  }
  return !hasConfiguredSecretInput(
    params.cfg.gateway?.auth?.password,
    params.cfg.secrets?.defaults,
  );
}

async function resolveGatewayTokenSecretRef(
  cfg: ClawserConfig,
  env: NodeJS.ProcessEnv,
  authOverride?: GatewayAuthConfig,
): Promise<string | undefined> {
  if (!shouldResolveGatewayTokenSecretRef({ cfg, env, authOverride })) {
    return undefined;
  }
  return await resolveRequiredConfiguredSecretRefInputString({
    config: cfg,
    env,
    value: cfg.gateway?.auth?.token,
    path: "gateway.auth.token",
  });
}

function shouldResolveGatewayPasswordSecretRef(params: {
  cfg: ClawserConfig;
  env: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
}): boolean {
  if (hasGatewayPasswordOverrideCandidate(params)) {
    return false;
  }
  const explicitMode = params.authOverride?.mode ?? params.cfg.gateway?.auth?.mode;
  if (explicitMode === "password") {
    return true;
  }
  if (explicitMode === "token" || explicitMode === "none") {
    return false;
  }

  if (hasGatewayTokenCandidate(params)) {
    return false;
  }
  return true;
}

async function resolveGatewayPasswordSecretRef(
  cfg: ClawserConfig,
  env: NodeJS.ProcessEnv,
  authOverride?: GatewayAuthConfig,
): Promise<string | undefined> {
  if (!shouldResolveGatewayPasswordSecretRef({ cfg, env, authOverride })) {
    return undefined;
  }
  return await resolveRequiredConfiguredSecretRefInputString({
    config: cfg,
    env,
    value: cfg.gateway?.auth?.password,
    path: "gateway.auth.password",
  });
}

export async function ensureGatewayStartupAuth(params: {
  cfg: ClawserConfig;
  env?: NodeJS.ProcessEnv;
  authOverride?: GatewayAuthConfig;
  persist?: boolean;
}): Promise<{
  cfg: ClawserConfig;
  auth: ReturnType<typeof resolveGatewayAuth>;
  generatedToken?: string;
  persistedGeneratedToken: boolean;
}> {
  assertExplicitGatewayAuthModeWhenBothConfigured(params.cfg);
  const env = params.env ?? process.env;
  const persistRequested = params.persist === true;
  const [resolvedTokenRefValue, resolvedPasswordRefValue] = await Promise.all([
    resolveGatewayTokenSecretRef(params.cfg, env, params.authOverride),
    resolveGatewayPasswordSecretRef(params.cfg, env, params.authOverride),
  ]);
  const authOverride: GatewayAuthConfig | undefined =
    params.authOverride || resolvedTokenRefValue || resolvedPasswordRefValue
      ? {
          ...params.authOverride,
          ...(resolvedTokenRefValue ? { token: resolvedTokenRefValue } : {}),
          ...(resolvedPasswordRefValue ? { password: resolvedPasswordRefValue } : {}),
        }
      : undefined;
  const resolved = resolveGatewayAuthFromConfig({
    cfg: params.cfg,
    env,
    authOverride,
  });
  if (resolved.mode !== "token" || (resolved.token?.trim().length ?? 0) > 0) {
    assertHooksTokenSeparateFromGatewayAuth({ cfg: params.cfg, auth: resolved });
    return { cfg: params.cfg, auth: resolved, persistedGeneratedToken: false };
  }

  const generatedToken = crypto.randomBytes(24).toString("hex");
  const nextCfg: ClawserConfig = {
    ...params.cfg,
    gateway: {
      ...params.cfg.gateway,
      auth: {
        ...params.cfg.gateway?.auth,
        mode: "token",
        token: generatedToken,
      },
    },
  };
  const persist = shouldPersistGeneratedToken({
    persistRequested,
    resolvedAuth: resolved,
  });
  if (persist) {
    await writeConfigFile(nextCfg);
  }

  const nextAuth = resolveGatewayAuthFromConfig({
    cfg: nextCfg,
    env,
    authOverride: params.authOverride,
  });
  assertHooksTokenSeparateFromGatewayAuth({ cfg: nextCfg, auth: nextAuth });
  return {
    cfg: nextCfg,
    auth: nextAuth,
    generatedToken,
    persistedGeneratedToken: persist,
  };
}

export function assertHooksTokenSeparateFromGatewayAuth(params: {
  cfg: ClawserConfig;
  auth: ResolvedGatewayAuth;
}): void {
  if (params.cfg.hooks?.enabled !== true) {
    return;
  }
  const hooksToken =
    typeof params.cfg.hooks.token === "string" ? params.cfg.hooks.token.trim() : "";
  if (!hooksToken) {
    return;
  }
  const gatewayToken =
    params.auth.mode === "token" && typeof params.auth.token === "string"
      ? params.auth.token.trim()
      : "";
  if (!gatewayToken) {
    return;
  }
  if (hooksToken !== gatewayToken) {
    return;
  }
  throw new Error(
    "Invalid config: hooks.token must not match gateway auth token. Set a distinct hooks.token for hook ingress.",
  );
}
