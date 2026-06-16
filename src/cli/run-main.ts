import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadDotEnv } from "../infra/dotenv.js";
import { formatUncaughtError } from "../infra/errors.js";
import { isMainModule } from "../infra/is-main.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { installUnhandledRejectionHandler } from "../infra/unhandled-rejections.js";
import { enableConsoleCapture } from "../logging.js";
import { hasHelpOrVersion } from "./argv.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "./profile.js";
import { normalizeWindowsArgv } from "./windows-argv.js";

async function closeCliMemoryManagers(): Promise<void> {}

export function rewriteUpdateFlagArgv(argv: string[]): string[] {
  const index = argv.indexOf("--update");
  if (index === -1) {
    return argv;
  }

  const next = [...argv];
  next.splice(index, 1, "update");
  return next;
}

export function shouldRegisterPrimarySubcommand(argv: string[]): boolean {
  return !hasHelpOrVersion(argv);
}

export function shouldSkipPluginCommandRegistration(params: {
  argv: string[];
  primary: string | null;
  hasBuiltinPrimary: boolean;
}): boolean {
  if (params.hasBuiltinPrimary) {
    return true;
  }
  if (!params.primary) {
    return hasHelpOrVersion(params.argv);
  }
  return false;
}

export function shouldEnsureCliPath(argv: string[]): boolean {
  return !hasHelpOrVersion(argv);
}

export async function runCli(argv: string[] = process.argv) {
  let normalizedArgv = normalizeWindowsArgv(argv);
  const parsedProfile = parseCliProfileArgs(normalizedArgv);
  if (!parsedProfile.ok) {
    throw new Error(parsedProfile.error);
  }
  if (parsedProfile.profile) {
    applyCliProfileEnv({ profile: parsedProfile.profile });
  }
  normalizedArgv = parsedProfile.argv;

  loadDotEnv({ quiet: true });

  // Enforce the minimum supported runtime before doing any work.
  assertSupportedRuntime();

  try {
    // Capture all console output into structured logs while keeping stdout/stderr behavior.
    enableConsoleCapture();

    const { buildBrowserOnlyProgram } = await import("./program.js");
    const program = buildBrowserOnlyProgram();

    // Global error handlers to prevent silent crashes from unhandled rejections/exceptions.
    // These log the error and exit gracefully instead of crashing without trace.
    installUnhandledRejectionHandler();

    process.on("uncaughtException", (error) => {
      console.error("[clawser] Uncaught exception:", formatUncaughtError(error));
      process.exit(1);
    });

    await program.parseAsync(rewriteUpdateFlagArgv(normalizedArgv));
  } finally {
    await closeCliMemoryManagers();
  }
}

export function isCliMainModule(): boolean {
  return isMainModule({ currentFile: fileURLToPath(import.meta.url) });
}
