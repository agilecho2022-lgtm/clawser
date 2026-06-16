import type { Command } from "commander";
import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { registerBrowserActionInputCommands } from "./browser-cli-actions-input.js";
import { registerBrowserActionObserveCommands } from "./browser-cli-actions-observe.js";
import { registerBrowserDebugCommands } from "./browser-cli-debug.js";
import { browserActionExamples, browserCoreExamples } from "./browser-cli-examples.js";
import { registerBrowserExtensionCommands } from "./browser-cli-extension.js";
import { registerBrowserInspectCommands } from "./browser-cli-inspect.js";
import { registerBrowserManageCommands } from "./browser-cli-manage.js";
import { registerBrowserStateCommands } from "./browser-cli-state.js";
import { formatCliCommand } from "./command-format.js";
import { addGatewayClientOptions } from "./gateway-rpc.js";
import { formatHelpExamples } from "./help-format.js";

export function registerBrowserCli(program: Command) {
  const browser = program
    .command("browser")
    .description("Manage Clawser's dedicated browser (Chrome/Chromium)")
    .option("--browser-profile <name>", "Browser profile name (default from config)")
    .option("--json", "Output machine-readable JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples(
          [...browserCoreExamples, ...browserActionExamples].map((cmd) => [
            formatCliCommand(cmd),
            "",
          ]),
          true,
        )}\n`,
    )
    .action(() => {
      browser.outputHelp();
      defaultRuntime.error(
        danger(`Missing subcommand. Try: "clawser status"`),
      );
      defaultRuntime.exit(1);
    });

  addGatewayClientOptions(browser);

  const parentOpts = (cmd: Command) => {
    let current: Command | null = cmd;
    while (current && current.name() !== "browser") {
      current = current.parent ?? null;
    }
    return current?.opts?.() ?? {};
  };

  registerBrowserManageCommands(browser, parentOpts);
  registerBrowserExtensionCommands(browser, parentOpts);
  registerBrowserInspectCommands(browser, parentOpts);
  registerBrowserActionInputCommands(browser, parentOpts);
  registerBrowserActionObserveCommands(browser, parentOpts);
  registerBrowserDebugCommands(browser, parentOpts);
  registerBrowserStateCommands(browser, parentOpts);
}
