import { createServer } from "node:http";
import vm from "node:vm";
import { chromium } from "playwright-core";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { rawDataToString } from "../infra/ws.js";
import { getPageForTargetId, closePlaywrightBrowserConnection } from "./pw-session.js";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await closePlaywrightBrowserConnection();
  vi.restoreAllMocks();
  for (const close of closers.splice(0).toReversed()) {
    await close();
  }
});

async function fixture(options: {
  cached: string[];
  current: string[];
  publish?: number;
  blocked?: boolean;
  blockedPage?: number;
  inventory?: unknown;
  native?: boolean;
  closeOnCleanup?: boolean;
}) {
  const closed = options.current.map(() => false);
  const worlds = options.current.map(() =>
    vm.createContext({
      document: {},
      setTimeout: (fn: () => void, ms: number) => {
        const timer = setTimeout(fn, ms);
        timer.unref();
      },
    }),
  );
  const pages = options.current.map((url, index) => ({
    url: () => url,
    on: vi.fn(),
    isClosed: () => closed[index],
    evaluate: async (fn: Function, arg: unknown) =>
      index === options.blockedPage
        ? await new Promise(() => {})
        : vm.runInContext(`(${fn.toString()})(${JSON.stringify(arg)})`, worlds[index]),
  }));
  const context = { pages: () => pages.slice(0, options.publish ?? pages.length), on: vi.fn() };
  vi.spyOn(chromium, "connectOverCDP").mockResolvedValue({
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: async () => {},
  } as never);
  let cdpUrl = "";
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(
        req.url?.startsWith("/json/version")
          ? {
              Browser: options.native ? "Chrome/Test" : "Clawser/extension-relay",
              webSocketDebuggerUrl: cdpUrl.replace("http", "ws") + "/cdp",
            }
          : (options.inventory ?? options.cached.map((url, i) => ({ id: `TARGET_${i}`, url }))),
      ),
    );
  });
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) =>
    socket.on("message", (raw) => {
      const message = JSON.parse(rawDataToString(raw)),
        index = Number(message.params?.targetId?.split("_")[1]);
      if (options.blocked) {
        return;
      }
      try {
        const value = vm.runInContext(message.params.expression, worlds[index]);
        if (options.closeOnCleanup && message.params.expression.startsWith("delete document[")) {
          closed[index] = true;
        }
        socket.send(JSON.stringify({ id: message.id, result: { result: { value } } }));
      } catch (error) {
        socket.send(JSON.stringify({ id: message.id, error: { message: String(error) } }));
      }
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cdpUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  closers.push(async () => {
    for (const socket of sockets.clients) {
      socket.terminate();
    }
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { cdpUrl, pages, worlds };
}

it("proves native identity instead of selecting the other Page at the cached URL", async () => {
  const f = await fixture({
    cached: ["https://test/old", "https://test/before"],
    current: ["https://test/new", "https://test/old"],
  });
  expect(await getPageForTargetId({ cdpUrl: f.cdpUrl, targetId: "TARGET_0" })).toBe(f.pages[0]);
  expect(await getPageForTargetId({ cdpUrl: f.cdpUrl, targetId: "TARGET_1" })).toBe(f.pages[1]);
  for (const world of f.worlds) {
    expect(vm.runInContext("Object.getOwnPropertyNames(document)", world)).toEqual([]);
  }
});

it.each(["https://test/same", "about:blank"])(
  "resolves two pages sharing %s by exact target proof",
  async (url) => {
    const f = await fixture({ cached: [url, url], current: [url, url] });
    expect(await getPageForTargetId({ cdpUrl: f.cdpUrl, targetId: "TARGET_1" })).toBe(f.pages[1]);
  },
);

it("reports a present but unpublished native target as unavailable, never physically missing", async () => {
  const f = await fixture({
    cached: ["https://test/same", "https://test/same"],
    current: ["https://test/same", "https://test/same"],
    publish: 1,
  });
  await expect(
    getPageForTargetId({ cdpUrl: f.cdpUrl, targetId: "TARGET_1" }),
  ).rejects.toMatchObject({ status: 409 });
});

it("keeps a confirmed absent target distinct from an unobservable identity", async () => {
  const f = await fixture({ cached: ["https://test/"], current: ["https://test/"] });
  await expect(getPageForTargetId({ cdpUrl: f.cdpUrl, targetId: "MISSING" })).rejects.toMatchObject(
    { status: 404 },
  );
});

it("does not wait for an unrelated stalled Page once the requested target is proved", async () => {
  const f = await fixture({
    cached: ["https://test/a", "https://test/b"],
    current: ["https://test/a", "https://test/b"],
    blockedPage: 1,
  });
  const started = Date.now();
  expect(await getPageForTargetId({ cdpUrl: f.cdpUrl, targetId: "TARGET_0" })).toBe(f.pages[0]);
  expect(Date.now() - started).toBeLessThan(1500);
});

it("bounds an unobservable identity and reports 409 rather than missing", async () => {
  const f = await fixture({
    cached: ["https://test/a"],
    current: ["https://test/a"],
    blocked: true,
  });
  const started = Date.now();
  await expect(
    getPageForTargetId({ cdpUrl: f.cdpUrl, targetId: "TARGET_0" }),
  ).rejects.toMatchObject({ status: 409 });
  expect(Date.now() - started).toBeLessThan(4000);
});

it("refreshes the published Page inventory on the one bounded re-resolution", async () => {
  const options = {
    cached: ["https://test/a", "https://test/b"],
    current: ["https://test/a", "https://test/b"],
    publish: 1,
  };
  const f = await fixture(options);
  const timer = setTimeout(() => {
    options.publish = 2;
  }, 30);
  try {
    expect(await getPageForTargetId({ cdpUrl: f.cdpUrl, targetId: "TARGET_1" })).toBe(f.pages[1]);
  } finally {
    clearTimeout(timer);
  }
});

it("does not return a Page retired during the final async challenge cleanup", async () => {
  const f = await fixture({
    cached: ["https://test/a"],
    current: ["https://test/a"],
    closeOnCleanup: true,
  });
  await expect(
    getPageForTargetId({ cdpUrl: f.cdpUrl, targetId: "TARGET_0" }),
  ).rejects.toMatchObject({ status: 409 });
});

it.each([false, true])(
  "does not turn malformed inventory into missing (native=%s)",
  async (native) => {
    for (const inventory of [[{ url: "https://test/a" }], [null], [{ id: "" }]]) {
      const f = await fixture({ cached: [], current: ["https://test/a"], inventory, native });
      await expect(
        getPageForTargetId({ cdpUrl: f.cdpUrl, targetId: "TARGET_0" }),
      ).rejects.toMatchObject({ status: 409 });
    }
  },
);
