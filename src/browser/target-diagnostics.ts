import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type TargetDiagnostic = {
  event: "target_lookup" | "route_error";
  source_layer: "server_context" | "route_tab_error" | "route_browser_error";
  target_id?: string;
  result?: "found" | "missing" | "ambiguous" | "list_error";
  candidate_count?: number;
  visible_tab_count?: number;
  http_status?: number;
};

// Only target identity and counts are persisted. Never log a tab URL, page title,
// command arguments, request body, selector, or the original error message.
export function writeTargetDiagnostic(entry: TargetDiagnostic): void {
  try {
    const file =
      process.env.CLAWSER_TARGET_DIAGNOSTIC_LOG ||
      process.env.BILLRPA_RELAY_LOG ||
      path.join(os.homedir(), ".billrpa", "log.txt");
    const targetId = String(entry.target_id || "");
    const safeTargetId = /^[A-Za-z0-9-]{1,64}$/.test(targetId) ? targetId : "";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `[clawser-target-diagnostic] ${JSON.stringify({ at: new Date().toISOString(), ...entry, target_id: safeTargetId })}\n`,
    );
  } catch {
    // Diagnostics cannot change browser behavior.
  }
}
