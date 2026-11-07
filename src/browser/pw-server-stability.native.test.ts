import { createServer } from "node:http";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closePlaywrightBrowserConnection, getPageForTargetId, refLocator } from "./pw-session.js";
import {
  clickViaPlaywright,
  dragViaPlaywright,
  typeViaPlaywright,
  waitForViaPlaywright,
} from "./pw-tools-core.interactions.js";
import { snapshotAriaViaPlaywright, snapshotRoleViaPlaywright } from "./pw-tools-core.snapshot.js";
import { getFreePort } from "./test-port.js";

const nativeEnabled = process.env.CLAWSER_NATIVE_BROWSER_TEST === "1";
const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  await closePlaywrightBrowserConnection();
  for (const close of closers.splice(0).toReversed()) {
    await close();
  }
});
async function fixture(): Promise<{
  page: Page;
  browser: Browser;
  cdpUrl: string;
  targetId: string;
  base: string;
}> {
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    if (req.url?.startsWith("/drag")) {
      res.end(
        '<div id="source" role="button" draggable="true" ondragstart="event.dataTransfer.setData(\'text/plain\',\'test\')" style="width:100px;height:100px">Source</div><div role="button" ondragover="event.preventDefault()" ondrop="event.preventDefault();document.body.dataset.dropped=\'yes\'" style="margin-top:40px;width:100px;height:100px">Destination</div>',
      );
      return;
    }
    if (req.url === "/form") {
      res.end(
        '<input type="checkbox" aria-label="Accept"><select aria-label="Choice"><option value="a">A</option><option value="b">B</option></select>',
      );
      return;
    }
    if (req.url === "/frames") {
      res.end(
        '<button>Main</button><iframe id="main" src="/inner"></iframe><iframe id="other" src="/ad"></iframe>',
      );
      return;
    }
    res.end(
      `<script>window.ready=${req.url === "/replacement"};</script><h1>Title</h1><button ${req.url === "/blocked" ? "disabled" : ""} onclick="document.body.dataset.clicked='yes'">Submit</button><input aria-label="Name" ${req.url === "/blocked" ? "readonly" : ""} oninput="document.body.dataset.written=this.value">`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture port unavailable");
  }
  const port = await getFreePort();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CLAWSER_NATIVE_BROWSER_EXECUTABLE,
    args: [`--remote-debugging-port=${port}`],
  });
  closers.push(() => browser.close());
  const page = await browser.newPage();
  const base = `http://127.0.0.1:${address.port}`;
  await page.goto(base);
  const session = await page.context().newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach();
  return { page, browser, base, cdpUrl: `http://127.0.0.1:${port}`, targetId: targetInfo.targetId };
}

describe.runIf(nativeEnabled)("browser server native stability", () => {
  it.each(["pushState", "hash"])(
    "continues executable waits across same-document %s updates",
    async (kind) => {
      const f = await fixture();
      const page = await getPageForTargetId(f);
      let captured!: () => void;
      const gate = new Promise<void>((resolve) => {
        captured = resolve;
      });
      const original = page.evaluateHandle.bind(page);
      const spy = vi.spyOn(page, "evaluateHandle").mockImplementation(async (...args) => {
        const handle = await original(...args);
        captured();
        return handle;
      });
      const waiting = waitForViaPlaywright({ ...f, fn: "window.ready", timeoutMs: 2000 });
      void waiting.catch(() => {});
      try {
        await gate;
        await f.page.evaluate((kind) => {
          if (kind === "hash") {
            location.hash = "next";
          } else {
            history.pushState({}, "", "/spa");
          }
          (window as unknown as { ready: boolean }).ready = true;
        }, kind);
        await expect(waiting).resolves.toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    },
  );
  it("preserves pinned select, checkbox, evaluate and screenshot actions", async () => {
    const f = await fixture();
    await f.page.goto(`${f.base}/form`);
    const snapshot = await snapshotRoleViaPlaywright(f);
    const page = await getPageForTargetId(f);
    const byRole = (role: string) =>
      refLocator(page, Object.entries(snapshot.refs).find(([, info]) => info.role === role)![0]);
    const checkbox = byRole("checkbox"),
      select = byRole("combobox");
    await checkbox.setChecked(true, { timeout: 1500 });
    await select.selectOption("b", { timeout: 1500 });
    expect(await checkbox.evaluate((node) => (node as HTMLInputElement).checked)).toBe(true);
    expect(await select.evaluate((node) => (node as HTMLSelectElement).value)).toBe("b");
    expect((await checkbox.screenshot({ timeout: 1500 })).byteLength).toBeGreaterThan(0);
  });

  it.each([false, true])(
    "pins drag endpoints and removes temporary markers (navigate=%s)",
    async (navigate) => {
      const f = await fixture();
      await f.page.goto(`${f.base}/drag`);
      const snapshot = await snapshotRoleViaPlaywright(f);
      const named = (name: string) =>
        Object.entries(snapshot.refs).find(([, info]) => info.name === name)![0];
      if (navigate) {
        await f.page.locator("#source").evaluate((node) => {
          node.style.visibility = "hidden";
        });
      }
      const pending = dragViaPlaywright({
        ...f,
        startRef: named("Source"),
        endRef: named("Destination"),
        timeoutMs: 1500,
      });
      const outcome = pending.then(
        () => "completed",
        (error) => String(error),
      );
      if (navigate) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await f.page.goto(`${f.base}/drag-replacement`);
        expect(await outcome).not.toBe("completed");
        expect(await f.page.getAttribute("body", "data-dropped")).toBeNull();
      } else {
        expect(await outcome).toBe("completed");
        expect(await f.page.getAttribute("body", "data-dropped")).toBe("yes");
      }
      expect(
        await f.page
          .locator("*")
          .evaluateAll((nodes) =>
            nodes.flatMap((node) =>
              node.getAttributeNames().filter((name) => name.startsWith("data-clawser-drag-")),
            ),
          ),
      ).toEqual([]);
    },
  );

  it("stops delayed typing before a replacement document receives characters", async () => {
    const f = await fixture();
    const snapshot = await snapshotRoleViaPlaywright(f);
    const ref = Object.entries(snapshot.refs).find(([, info]) => info.role === "textbox")![0];
    const pending = typeViaPlaywright({
      ...f,
      ref,
      text: "abcdefghijklmnop",
      slowly: true,
      timeoutMs: 2500,
    });
    const outcome = pending.then(
      () => "completed",
      (error) => String(error),
    );
    await expect.poll(() => f.page.locator("input").inputValue()).not.toBe("");
    await f.page.goto(`${f.base}/replacement`);
    await f.page.locator("input").focus();
    expect(await outcome).not.toBe("completed");
    expect(await f.page.locator("input").inputValue()).toBe("");
  });
  it("retires raw AX refs after subframe navigation even when role refs remain usable", async () => {
    const f = await fixture();
    await f.page.goto(`${f.base}/frames`);
    await snapshotRoleViaPlaywright(f);
    const raw = await snapshotAriaViaPlaywright(f);
    const ref = raw.nodes.find((node) => node.role === "button")!.ref;
    const page = await getPageForTargetId(f);
    const navigation = page.waitForEvent(
      "framenavigated",
      (frame) => frame.url() === `${f.base}/replacement`,
    );
    await f.page
      .frames()
      .find((frame) => frame.url().endsWith("/ad"))!
      .goto(`${f.base}/replacement`);
    await navigation;
    expect(() => refLocator(page, ref)).toThrow(/stale|new snapshot/i);
  });

  it("retires a raw-only snapshot after main navigation and connection replacement", async () => {
    const f = await fixture();
    const raw = await snapshotAriaViaPlaywright(f);
    const ref = raw.nodes.find((node) => node.role === "button")!.ref;
    const original = await getPageForTargetId(f);
    const navigation = original.waitForURL(`${f.base}/replacement`);
    await f.page.goto(`${f.base}/replacement`);
    await navigation;
    expect(() => refLocator(original, ref)).toThrow(/stale|new snapshot/i);
    await closePlaywrightBrowserConnection({ cdpUrl: f.cdpUrl });
    const replacement = await getPageForTargetId(f);
    expect(() => refLocator(replacement, ref)).toThrow(/stale|new snapshot/i);
  });

  it.each(["click", "fill"] as const)(
    "does not retarget an in-flight blocked %s into a replacement document",
    async (kind) => {
      const f = await fixture();
      await f.page.goto(`${f.base}/blocked`);
      const snapshot = await snapshotRoleViaPlaywright(f);
      const role = kind === "click" ? "button" : "textbox";
      const ref = Object.entries(snapshot.refs).find(([, info]) => info.role === role)![0];
      const pending =
        kind === "click"
          ? clickViaPlaywright({ ...f, ref, timeoutMs: 2500 })
          : (await import("./pw-tools-core.interactions.js")).typeViaPlaywright({
              ...f,
              ref,
              text: "synthetic-test",
              timeoutMs: 2500,
            });
      const outcome = pending.then(
        () => "wrongly completed",
        (error) => String(error),
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await f.page.goto(`${f.base}/replacement`);
      expect(await outcome).not.toBe("wrongly completed");
      expect(
        await f.page.getAttribute("body", kind === "click" ? "data-clicked" : "data-written"),
      ).toBeNull();
    },
  );

  it("includes a busy renderer's Document capture in the executable-wait deadline", async () => {
    const f = await fixture();
    await getPageForTargetId(f);
    await f.page.evaluate(() => {
      setTimeout(() => {
        const until = Date.now() + 1800;
        while (Date.now() < until) {
          /* fixture: occupy the renderer */
        }
      }, 50);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const started = Date.now();
    await expect(waitForViaPlaywright({ ...f, fn: "true", timeoutMs: 600 })).rejects.toThrow(
      /600ms/,
    );
    expect(Date.now() - started).toBeLessThan(1300);
  });
  it("does not revive stale role refs when only a raw AX snapshot is refreshed", async () => {
    const f = await fixture();
    const snapshot = await snapshotRoleViaPlaywright(f);
    const ref = Object.entries(snapshot.refs).find(([, info]) => info.role === "button")![0];
    const page = await getPageForTargetId(f);
    await f.page.goto(`${f.base}/replacement`);
    await snapshotAriaViaPlaywright(f);
    expect(() => refLocator(page, ref)).toThrow(/stale|new snapshot/i);
  });
  it("uses the requested executable-wait deadline instead of Playwright's default", async () => {
    const f = await fixture();
    await getPageForTargetId(f);
    const started = Date.now();
    const pending = waitForViaPlaywright({ ...f, fn: "false", timeoutMs: 600 });
    void pending.catch(() => {});
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(
        Promise.race([
          pending,
          new Promise((_, reject) => {
            watchdog = setTimeout(() => reject(new Error("caller deadline was ignored")), 2000);
          }),
        ]),
      ).rejects.toThrow(/600ms/);
      expect(Date.now() - started).toBeLessThan(1800);
    } finally {
      clearTimeout(watchdog);
    }
  });

  it("does not satisfy an executable wait using a replacement document", async () => {
    const f = await fixture();
    await getPageForTargetId(f);
    const waiting = waitForViaPlaywright({ ...f, fn: "() => window.ready", timeoutMs: 2500 });
    const outcome = waiting.then(
      () => "wrongly satisfied",
      (error) => String(error),
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await f.page.goto(`${f.base}/replacement`);
    expect(await outcome).toMatch(/document|context|JSHandle/i);
  });

  it.each([
    "window.ready",
    "() => window.ready",
    "return window.ready;",
    "async () => window.ready",
    "window.ready;",
  ])("waits until truthy for predicate source %s", async (fn) => {
    const f = await fixture();
    await getPageForTargetId(f);
    await f.page.evaluate(() => {
      (window as unknown as { ready: boolean }).ready = false;
      setTimeout(() => {
        (window as unknown as { ready: boolean }).ready = true;
      }, 200);
    });
    const started = Date.now();
    await waitForViaPlaywright({ ...f, fn, timeoutMs: 1500 });
    expect(Date.now() - started).toBeGreaterThan(100);
  });

  it("rejects an old ref after navigation without clicking a replacement control, then accepts a fresh snapshot", async () => {
    const f = await fixture();
    const snapshot = await snapshotRoleViaPlaywright(f);
    const ref = Object.entries(snapshot.refs).find(([, info]) => info.role === "button")![0];
    await f.page.goto(`${f.base}/replacement`);
    await expect(clickViaPlaywright({ ...f, ref })).rejects.toThrow(/stale|new snapshot/i);
    expect(await f.page.getAttribute("body", "data-clicked")).toBeNull();
    const fresh = await snapshotRoleViaPlaywright(f);
    await clickViaPlaywright({
      ...f,
      ref: Object.entries(fresh.refs).find(([, info]) => info.role === "button")![0],
    });
    expect(await f.page.getAttribute("body", "data-clicked")).toBe("yes");
  });

  it("does not renumber an existing snapshot when an unknown ref is requested", async () => {
    const f = await fixture();
    const snapshot = await snapshotRoleViaPlaywright(f);
    const buttonRef = Object.entries(snapshot.refs).find(([, info]) => info.role === "button")![0];
    await expect(clickViaPlaywright({ ...f, ref: "e9999" })).rejects.toThrow(/Unknown ref/);
    await clickViaPlaywright({ ...f, ref: buttonRef });
    expect(await f.page.getAttribute("body", "data-clicked")).toBe("yes");
  });

  it("preserves legacy cold-start ref refresh when there has been no snapshot", async () => {
    const f = await fixture();
    await clickViaPlaywright({ ...f, ref: "e1" });
    expect(await f.page.getAttribute("body", "data-clicked")).toBe("yes");
  });

  it("keeps cold-start compatibility after navigation when no refs have ever been issued", async () => {
    const f = await fixture();
    await getPageForTargetId(f);
    await f.page.goto(`${f.base}/replacement`);
    await clickViaPlaywright({ ...f, ref: "e1" });
    expect(await f.page.getAttribute("body", "data-clicked")).toBe("yes");
  });

  it("binds iframe refs to the selected frame and retires them after that frame navigates", async () => {
    const f = await fixture();
    await f.page.goto(`${f.base}/frames`);
    const snapshot = await snapshotRoleViaPlaywright({ ...f, frameSelector: "iframe#main" });
    const ref = Object.entries(snapshot.refs).find(([, info]) => info.role === "button")![0];
    const other = f.page.frames().find((frame) => frame.url().endsWith("/ad"))!;
    await other.goto(`${f.base}/replacement`);
    await clickViaPlaywright({ ...f, ref });
    const selected = f.page.frames().find((frame) => frame.url().endsWith("/inner"))!;
    expect(await selected.getAttribute("body", "data-clicked")).toBe("yes");
    await selected.goto(`${f.base}/replacement`);
    await expect(clickViaPlaywright({ ...f, ref })).rejects.toThrow(/stale|new snapshot/i);
    expect(await selected.getAttribute("body", "data-clicked")).toBeNull();
  });

  it("does not publish a snapshot captured before an intervening navigation", async () => {
    const f = await fixture();
    const resolved = await getPageForTargetId(f);
    let captured!: () => void, release!: () => void;
    const capturedPromise = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const locator = resolved.locator.bind(resolved);
    const spy = vi
      .spyOn(resolved, "locator")
      .mockImplementation((...args: Parameters<Page["locator"]>) => {
        const result = locator(...args),
          snapshot = result.ariaSnapshot.bind(result);
        result.ariaSnapshot = async (...options) => {
          const old = await snapshot(...options);
          captured();
          await gate;
          return old;
        };
        return result;
      });
    const pending = snapshotRoleViaPlaywright(f);
    void pending.catch(() => {});
    try {
      await capturedPromise;
      const navigated = resolved.waitForEvent("framenavigated");
      await f.page.goto(`${f.base}/replacement`);
      await navigated;
      release();
      await expect(pending).rejects.toThrow(/stale|new snapshot/i);
    } finally {
      release();
      spy.mockRestore();
    }
  });
});
