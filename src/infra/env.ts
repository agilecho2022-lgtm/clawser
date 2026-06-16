import { parseBooleanValue } from "../utils/boolean.js";

export function isTruthyEnvValue(value?: string): boolean {
  return parseBooleanValue(value) === true;
}
