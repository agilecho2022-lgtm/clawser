import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { stripAnsi } from "../../terminal/ansi.js";
import { registerBrowserCli } from "../browser-cli.js";
import type { ProgramContext } from "./context.js";

process.env.NO_COLOR = "1";
process.env.FORCE_COLOR = "0";

const createProgramContextMock = vi.fn();
const registerPreActionHooksMock = vi.fn();
const setProgramContextMock = vi.fn();

vi.mock("./context.js", () => ({
  createProgramContext: createProgramContextMock,
}));

vi.mock("./preaction.js", () => ({
  registerPreActionHooks: registerPreActionHooksMock,
}));

vi.mock("./program-context.js", () => ({
  setProgramContext: setProgramContextMock,
}));

vi.mock("./command-registry.js", () => ({
  registerProgramCommands: vi.fn(() => {
    throw new Error("browser-only program must not register the full command registry");
  }),
}));

const { buildBrowserOnlyProgram } = await import("./build-browser-only-program.js");

function captureCommandHelp(command: Command) {
  let output = "";
  const write = (value: string) => {
    output += value;
  };
  command.configureOutput({ writeOut: write, writeErr: write });
  command.outputHelp();

  return stripAnsi(output);
}

function getBrowserCommand(program: Command) {
  const browser = program.commands.find((cmd) => cmd.name() === "browser");
  if (!browser) {
    throw new Error("browser command not registered");
  }
  return browser;
}

function buildDirectBrowserProgram() {
  const program = new Command();
  program.name("clawser");
  registerBrowserCli(program);
  return program;
}

describe("buildBrowserOnlyProgram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createProgramContextMock.mockReturnValue({
      programVersion: "9.9.9-test",
    } satisfies ProgramContext);
  });

  it("registers only the browser top-level command", () => {
    const program = buildBrowserOnlyProgram();
    const ctx = createProgramContextMock.mock.results[0]?.value as ProgramContext;

    expect(program).toBeInstanceOf(Command);
    expect(setProgramContextMock).toHaveBeenCalledWith(program, ctx);
    expect(registerPreActionHooksMock).toHaveBeenCalledWith(program, ctx.programVersion);
    expect(program.commands.map((command) => command.name())).toEqual(["browser"]);
  });

  it("does not expose non-browser commands", () => {
    const program = buildBrowserOnlyProgram();
    const commandNames = new Set(program.commands.map((command) => command.name()));

    expect(commandNames.has("browser")).toBe(true);
    expect(commandNames.has("status")).toBe(false);
    expect(commandNames.has("agent")).toBe(false);
    expect(commandNames.has("message")).toBe(false);
    expect(commandNames.has("gateway")).toBe(false);
  });

  it("keeps browser help identical to direct browser registration", () => {
    const browserOnlyHelp = captureCommandHelp(getBrowserCommand(buildBrowserOnlyProgram()));
    const directHelp = captureCommandHelp(getBrowserCommand(buildDirectBrowserProgram()));

    expect(browserOnlyHelp).toBe(directHelp);
  });

  it("keeps direct browser subcommand help identical to direct browser registration", () => {
    const browserOnly = getBrowserCommand(buildBrowserOnlyProgram());
    const direct = getBrowserCommand(buildDirectBrowserProgram());

    const browserOnlyHelp = browserOnly.commands.map(captureCommandHelp);
    const directHelp = direct.commands.map(captureCommandHelp);

    expect(browserOnlyHelp).toEqual(directHelp);
  });
});
