import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type CloseTrace = {
  close_id: string;
  initiator: string;
  initiator_pid?: number;
  task_id?: string;
  detail_id?: string;
  connection_id?: string;
};
const identity = (value: unknown): string =>
  typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value) ? value : "";

export function normalizeCloseTrace(value: unknown, fallback: string): CloseTrace {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const trace: CloseTrace = {
    close_id: identity(raw.close_id) || randomUUID(),
    initiator: identity(raw.initiator) || fallback,
  };
  if (Number.isSafeInteger(raw.initiator_pid) && Number(raw.initiator_pid) > 0) {
    trace.initiator_pid = Number(raw.initiator_pid);
  }
  for (const key of ["task_id", "detail_id", "connection_id"] as const) {
    if (identity(raw[key])) {
      trace[key] = identity(raw[key]);
    }
  }
  return trace;
}
export function closeTraceFromEnvironment(): CloseTrace {
  let raw: unknown;
  try {
    raw = JSON.parse(process.env.BILLRPA_CLOSE_CONTEXT || "null");
  } catch {
    raw = null;
  }
  const trace = normalizeCloseTrace(raw, "clawser.cli.close");
  trace.initiator_pid ||= process.pid;
  return trace;
}
export function writePageClose(
  trace: CloseTrace,
  phase: string,
  fields: Record<string, unknown> = {},
): void {
  try {
    const entry: Record<string, unknown> = {
      event: "page_close",
      at: new Date().toISOString(),
      phase,
      ...trace,
    };
    for (const key of [
      "source_layer",
      "ingress",
      "result",
      "requested_target_id",
      "actual_target_id",
      "native_tab_id",
      "cdp_client_id",
    ]) {
      if (typeof fields[key] === "string") {
        entry[key] = identity(fields[key]);
      } else if (typeof fields[key] === "number" && Number.isFinite(fields[key])) {
        entry[key] = fields[key];
      }
    }
    const file =
      process.env.CLAWSER_CLOSE_DIAGNOSTIC_LOG ||
      process.env.BILLRPA_RELAY_LOG ||
      path.join(os.homedir(), ".billrpa", "log.txt");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `[page-close] ${JSON.stringify(entry)}\n`);
  } catch {
    /* Logging must not change browser behavior. */
  }
}
