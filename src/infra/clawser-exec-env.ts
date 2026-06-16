export const CLAWSER_CLI_ENV_VAR = "CLAWSER_CLI";
export const CLAWSER_CLI_ENV_VALUE = "1";

export function markClawserExecEnv<T extends Record<string, string | undefined>>(env: T): T {
  return {
    ...env,
    [CLAWSER_CLI_ENV_VAR]: CLAWSER_CLI_ENV_VALUE,
  };
}

export function ensureClawserExecMarkerOnProcess(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  env[CLAWSER_CLI_ENV_VAR] = CLAWSER_CLI_ENV_VALUE;
  return env;
}
