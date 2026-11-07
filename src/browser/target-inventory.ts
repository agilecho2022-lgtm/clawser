import { BrowserTargetUnavailableError } from "./errors.js";

/** Absence is meaningful only in a well-formed, complete target inventory. */
export function assertTargetInventory(value: unknown): asserts value is Array<{ id: string }> {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) =>
        !entry || typeof entry !== "object" || typeof entry.id !== "string" || !entry.id.trim(),
    )
  ) {
    throw new BrowserTargetUnavailableError(
      "Target inventory is malformed; page absence is not established.",
    );
  }
}
