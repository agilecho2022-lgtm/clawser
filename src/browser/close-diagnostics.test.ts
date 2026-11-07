import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { normalizeCloseTrace, writePageClose } from "./close-diagnostics.js";
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it("close diagnostics do not persist extra fields, credential-shaped identifiers or URL query data", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "close-safe-"));
  dirs.push(dir);
  const file = path.join(dir, "trace");
  vi.stubEnv("CLAWSER_CLOSE_DIAGNOSTIC_LOG", file);
  const trace = normalizeCloseTrace(
    { close_id: "close-safe", initiator: "unit.test", task_id: "T", token: "SECRET" },
    "fallback",
  );
  writePageClose(trace, "requested", {
    source_layer: "relay",
    requested_target_id: "https://user:SECRET@ywb.test/?token=SECRET",
    token: "SECRET",
    url: "https://ywb.test/?token=SECRET",
  });
  const text = fs.readFileSync(file, "utf8");
  expect(text).not.toContain("SECRET");
  expect(text).not.toContain("https://");
  expect(text).toContain('"close_id":"close-safe"');
});
it("an unwritable diagnostic path never throws into the close caller", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "close-no-write-"));
  dirs.push(dir);
  vi.stubEnv("CLAWSER_CLOSE_DIAGNOSTIC_LOG", dir);
  expect(() =>
    writePageClose(normalizeCloseTrace(null, "unit.test"), "requested", {
      requested_target_id: "TARGET",
    }),
  ).not.toThrow();
});
