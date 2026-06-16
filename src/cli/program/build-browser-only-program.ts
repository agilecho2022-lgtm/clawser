import { Command } from "commander";
import { registerBrowserCli } from "../browser-cli.js";
import { resolveCliName } from "../cli-name.js";
import { CLI_LOG_LEVEL_VALUES, parseCliLogLevelOption } from "../log-level-option.js";
import { createProgramContext } from "./context.js";
import { registerPreActionHooks } from "./preaction.js";
import { setProgramContext } from "./program-context.js";

function configureBrowserOnlyRoot(program: Command, programVersion: string) {
  program
    .name(resolveCliName())
    .description("Browser CLI only")
    .version(programVersion)
    .option(
      "--dev",
      "Dev profile: isolate state under ~/.clawser-dev, default gateway port 19001, and shift derived browser ports",
    )
    .option(
      "--profile <name>",
      "Use a named profile (isolates state under ~/.clawser-<name>)",
    )
    .option(
      "--log-level <level>",
      `Global log level override for file + console (${CLI_LOG_LEVEL_VALUES})`,
      parseCliLogLevelOption,
    )
    .option("--no-color", "Disable ANSI colors", false);

  program.helpOption("-h, --help", "display help for command");
  program.helpCommand("help [command]", "display help for command");
}

export function buildBrowserOnlyProgram() {
  const program = new Command();
  const ctx = createProgramContext();

  setProgramContext(program, ctx);
  configureBrowserOnlyRoot(program, ctx.programVersion);
  registerPreActionHooks(program, ctx.programVersion);
  registerBrowserCli(program);

  return program;
}
