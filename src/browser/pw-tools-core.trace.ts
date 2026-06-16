import JSZip from "jszip";
import type WebSocket from "ws";
import { openCdpWebSocket } from "./cdp.helpers.js";
import { getChromeWebSocketUrl } from "./chrome.js";
import { writeViaSiblingTempPath } from "./output-atomic.js";
import { DEFAULT_TRACE_DIR } from "./paths.js";

type CdpMessage = {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message?: string };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

type CdpClient = {
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  waitForEvent: (method: string, timeoutMs: number) => Promise<CdpMessage>;
  close: () => void;
};

function parseMessage(data: WebSocket.RawData): CdpMessage | null {
  try {
    return JSON.parse(rawDataToUtf8(data));
  } catch {
    return null;
  }
}

function rawDataToUtf8(data: WebSocket.RawData): string {
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function createCdpClient(ws: WebSocket): CdpClient {
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const eventWaiters = new Map<string, Array<(message: CdpMessage) => void>>();

  const rejectAll = (err: Error) => {
    for (const [, p] of pending) {
      p.reject(err);
    }
    pending.clear();
  };

  ws.on("message", (data) => {
    const message = parseMessage(data);
    if (!message) {
      return;
    }
    if (typeof message.id === "number") {
      const p = pending.get(message.id);
      if (p) {
        pending.delete(message.id);
        if (message.error?.message) {
          p.reject(new Error(message.error.message));
        } else {
          p.resolve(message.result);
        }
      }
    }
    if (message.method) {
      const waiters = eventWaiters.get(message.method);
      if (waiters?.length) {
        const waiter = waiters.shift();
        waiter?.(message);
      }
    }
  });

  ws.once("error", (err) => {
    rejectAll(err instanceof Error ? err : new Error(String(err)));
  });
  ws.once("close", () => {
    rejectAll(new Error("CDP socket closed"));
  });

  return {
    send: (method, params) => {
      const id = nextId;
      nextId += 1;
      ws.send(JSON.stringify({ id, method, params }));
      return new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    waitForEvent: (method, timeoutMs) =>
      new Promise<CdpMessage>((resolve, reject) => {
        let done = false;
        const timer = setTimeout(() => {
          if (done) {
            return;
          }
          done = true;
          const waiters = eventWaiters.get(method) ?? [];
          eventWaiters.set(
            method,
            waiters.filter((waiter) => waiter !== onEvent),
          );
          reject(new Error(`Timeout waiting for ${method}`));
        }, timeoutMs);
        const onEvent = (message: CdpMessage) => {
          if (done) {
            return;
          }
          done = true;
          clearTimeout(timer);
          resolve(message);
        };
        const waiters = eventWaiters.get(method) ?? [];
        waiters.push(onEvent);
        eventWaiters.set(method, waiters);
      }),
    close: () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    },
  };
}

async function withTraceCdpClient<T>(cdpUrl: string, fn: (client: CdpClient) => Promise<T>) {
  const wsUrl = await getChromeWebSocketUrl(cdpUrl, 2000);
  if (!wsUrl) {
    throw new Error("CDP websocket unavailable");
  }
  const ws = openCdpWebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", (err) => reject(err));
    ws.once("close", () => reject(new Error("CDP socket closed")));
  });
  const client = createCdpClient(ws);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

function tracingCategories(opts: {
  screenshots?: boolean;
  snapshots?: boolean;
  sources?: boolean;
}) {
  const categories = [
    "-*",
    "devtools.timeline",
    "v8.execute",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-devtools.timeline.frame",
    "toplevel",
    "blink.console",
  ];
  if (opts.screenshots ?? true) {
    categories.push("disabled-by-default-devtools.screenshot");
  }
  if (opts.snapshots ?? true) {
    categories.push("disabled-by-default-devtools.timeline");
  }
  if (opts.sources) {
    categories.push("disabled-by-default-v8.cpu_profiler");
  }
  return Array.from(new Set(categories)).join(",");
}

async function readCdpStream(client: CdpClient, handle: string): Promise<string> {
  let output = "";
  for (;;) {
    const chunk = (await client.send("IO.read", { handle })) as {
      data?: string;
      eof?: boolean;
      base64Encoded?: boolean;
    };
    const data = String(chunk?.data ?? "");
    output += chunk?.base64Encoded ? Buffer.from(data, "base64").toString("utf8") : data;
    if (chunk?.eof) {
      break;
    }
  }
  await client.send("IO.close", { handle }).catch(() => {});
  return output;
}

async function buildTraceZip(tracePayload: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("trace.trace", tracePayload);
  zip.file(
    "README.txt",
    [
      "Clawser browser trace",
      "",
      "This archive contains a Chrome DevTools Protocol trace captured through the browser CLI.",
      "Open trace.trace in Chrome DevTools Performance tooling or compatible trace viewers.",
      "",
    ].join("\n"),
  );
  return await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

export async function traceStartViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  screenshots?: boolean;
  snapshots?: boolean;
  sources?: boolean;
}): Promise<void> {
  await withTraceCdpClient(opts.cdpUrl, async (client) => {
    await client.send("Tracing.start", {
      transferMode: "ReturnAsStream",
      categories: tracingCategories(opts),
    });
  });
}

export async function traceStopViaPlaywright(opts: {
  cdpUrl: string;
  targetId?: string;
  path: string;
}): Promise<void> {
  await withTraceCdpClient(opts.cdpUrl, async (client) => {
    const tracingComplete = client.waitForEvent("Tracing.tracingComplete", 30_000);
    await client.send("Tracing.end");
    const complete = await tracingComplete;
    const params = complete.params as { stream?: unknown } | undefined;
    const stream = typeof params?.stream === "string" ? params.stream : "";
    if (!stream) {
      throw new Error("Tracing completed without stream handle");
    }
    const tracePayload = await readCdpStream(client, stream);
    const zipBuffer = await buildTraceZip(tracePayload);
    await writeViaSiblingTempPath({
      rootDir: DEFAULT_TRACE_DIR,
      targetPath: opts.path,
      writeTemp: async (tempPath) => {
        await import("node:fs/promises").then((fs) => fs.writeFile(tempPath, zipBuffer));
      },
    });
  });
}
