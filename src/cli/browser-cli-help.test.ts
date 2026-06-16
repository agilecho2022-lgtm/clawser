import { Command } from "commander";
import { beforeAll, describe, expect, it } from "vitest";
import { stripAnsi } from "../terminal/ansi.js";

process.env.NO_COLOR = "1";
process.env.FORCE_COLOR = "0";

let registerBrowserCli: typeof import("./browser-cli.js").registerBrowserCli;

function createBrowserProgram() {
  const program = new Command();
  program.name("clawser");

  registerBrowserCli(program);

  const browser = program.commands.find((cmd) => cmd.name() === "browser");
  if (!browser) {
    throw new Error("browser command not registered");
  }

  return { program, browser };
}

function captureCommandHelp(command: Command) {
  let output = "";
  const write = (value: string) => {
    output += value;
  };
  command.configureOutput({ writeOut: write, writeErr: write });
  command.outputHelp();

  return stripAnsi(output);
}

function createBrowserHelpText() {
  const { browser } = createBrowserProgram();
  return captureCommandHelp(browser);
}

function createBrowserSubcommandHelpText() {
  const { browser } = createBrowserProgram();
  return browser.commands
    .map((command) => [`## ${command.name()}`, captureCommandHelp(command).trimEnd()].join("\n\n"))
    .join("\n\n---\n\n");
}

describe("browser CLI help", () => {
  beforeAll(async () => {
    ({ registerBrowserCli } = await import("./browser-cli.js"));
  });

  it("keeps the root browser command help stable", () => {
    expect(createBrowserHelpText()).toMatchInlineSnapshot(`
      "Usage: clawser browser [options] [command]

      Manage Clawser's dedicated browser (Chrome/Chromium)

      Options:
        --browser-profile <name>            Browser profile name (default from config)
        --json                              Output machine-readable JSON (default:
                                            false)
        --url <url>                         Gateway WebSocket URL (defaults to
                                            gateway.remote.url when configured)
        --token <token>                     Gateway token (if required)
        --timeout <ms>                      Timeout in ms (default: "30000")
        --expect-final                      Wait for the final browser response
                                            (default: false)
        -h, --help                          display help for command

      Commands:
        status                              Show browser status
        start                               Start the browser (no-op if already
                                            running)
        stop                                Stop the browser (best-effort)
        reset-profile                       Reset browser profile (moves it to Trash)
        tabs                                List open tabs
        tab                                 Tab shortcuts (index-based)
        open <url>                          Open a URL in a new tab
        focus <targetId>                    Focus a tab by target id (or unique
                                            prefix)
        close [targetId]                    Close a tab (target id optional)
        profiles                            List all browser profiles
        create-profile [options]            Create a new browser profile
        delete-profile [options]            Delete a browser profile
        extension                           Chrome extension helpers
        screenshot [options] [targetId]     Capture a screenshot (MEDIA:<path>)
        snapshot [options]                  Capture a snapshot (default: ai; aria is
                                            the accessibility tree)
        navigate [options] <url>            Navigate the current tab to a URL
        resize [options] <width> <height>   Resize the viewport
        click [options] <ref>               Click an element by ref from snapshot
        type [options] <ref> <text>         Type into an element by ref from snapshot
        press [options] <key>               Press a key
        hover [options] <ref>               Hover an element by ai ref
        scrollintoview [options] <ref>      Scroll an element into view by ref from
                                            snapshot
        drag [options] <startRef> <endRef>  Drag from one ref to another
        select [options] <ref> <values...>  Select option(s) in a select element
        upload [options] <paths...>         Arm file upload for the next file chooser
        waitfordownload [options] [path]    Wait for the next download (and save it)
        download [options] <ref> <path>     Click a ref and save the resulting
                                            download
        dialog [options]                    Arm the next modal dialog
                                            (alert/confirm/prompt)
        fill [options]                      Fill a form with JSON field descriptors
        wait [options] [selector]           Wait for time, selector, URL, load state,
                                            or JS conditions
        evaluate [options]                  Evaluate a function against the page or a
                                            ref
        console [options]                   Get recent console messages
        pdf [options]                       Save page as PDF
        responsebody [options] <url>        Wait for a network response and return its
                                            body
        highlight [options] <ref>           Highlight an element by ref
        errors [options]                    Get recent page errors
        requests [options]                  Get recent network requests (best-effort)
        trace                               Record a Playwright trace
        cookies [options]                   Read/write cookies
        storage                             Read/write localStorage/sessionStorage
        set                                 Browser environment settings

      Examples:
        clawser status
        clawser start
        clawser stop
        clawser tabs
        clawser open https://example.com
        clawser focus abcd1234
        clawser close abcd1234
        clawser screenshot
        clawser screenshot --full-page
        clawser screenshot --ref 12
        clawser snapshot
        clawser snapshot --format aria --limit 200
        clawser snapshot --efficient
        clawser snapshot --labels
        clawser navigate https://example.com
        clawser resize 1280 720
        clawser click 12 --double
        clawser type 23 "hello" --submit
        clawser press Enter
        clawser hover 44
        clawser drag 10 11
        clawser select 9 OptionA OptionB
        clawser upload /tmp/clawser/uploads/file.pdf
        clawser fill --fields '[{"ref":"1","value":"Ada"}]'
        clawser dialog --accept
        clawser wait --text "Done"
        clawser evaluate --fn '(el) => el.textContent' --ref 7
        clawser console --level error
        clawser pdf

      "
    `);
  });

  it("keeps direct browser subcommand help stable", () => {
    expect(createBrowserSubcommandHelpText()).toMatchSnapshot();
  });
});
