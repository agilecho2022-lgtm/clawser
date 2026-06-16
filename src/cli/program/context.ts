import { VERSION } from "../../version.js";

export type ProgramContext = {
  programVersion: string;
};

export function createProgramContext(): ProgramContext {
  return {
    programVersion: VERSION,
  };
}
