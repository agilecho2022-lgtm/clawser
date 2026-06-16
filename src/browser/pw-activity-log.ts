import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

export type BrowserActivityKind = "console" | "error" | "request";

type ActivityTarget = {
  cdpUrl: string;
  targetId: string;
};

type ActivityEntry<T> = {
  data: T;
  kind: BrowserActivityKind;
};

function normalizeActivityTarget(opts: ActivityTarget): ActivityTarget | null {
  const cdpUrl = opts.cdpUrl.trim().replace(/\/$/, "");
  const targetId = opts.targetId.trim();
  return cdpUrl && targetId ? { cdpUrl, targetId } : null;
}

function activityPath(opts: ActivityTarget): string | null {
  const target = normalizeActivityTarget(opts);
  if (!target) {
    return null;
  }
  const digest = createHash("sha256")
    .update(`${target.cdpUrl}\0${target.targetId}`)
    .digest("hex")
    .slice(0, 32);
  return path.join(resolveStateDir(), "browser", "activity", `${digest}.jsonl`);
}

export function appendBrowserActivity<T>(
  kind: BrowserActivityKind,
  opts: ActivityTarget,
  data: T,
): void {
  const file = activityPath(opts);
  if (!file) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ kind, data })}\n`);
  } catch {
    // Best-effort activity logs should never break browser actions.
  }
}

export function readBrowserActivity<T>(kind: BrowserActivityKind, opts: ActivityTarget): T[] {
  const file = activityPath(opts);
  if (!file) {
    return [];
  }
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: T[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Partial<ActivityEntry<T>>;
      if (parsed.kind === kind && parsed.data !== undefined) {
        out.push(parsed.data);
      }
    } catch {
      // Ignore malformed lines from partial writes or older formats.
    }
  }
  return out;
}

export function clearBrowserActivity(kind: BrowserActivityKind, opts: ActivityTarget): void {
  const file = activityPath(opts);
  if (!file) {
    return;
  }
  let text = "";
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as Partial<ActivityEntry<unknown>>;
      if (parsed.kind !== kind) {
        kept.push(trimmed);
      }
    } catch {
      kept.push(trimmed);
    }
  }
  try {
    if (kept.length) {
      fs.writeFileSync(file, `${kept.join("\n")}\n`);
    } else {
      fs.rmSync(file, { force: true });
    }
  } catch {
    // Best-effort cleanup only.
  }
}
