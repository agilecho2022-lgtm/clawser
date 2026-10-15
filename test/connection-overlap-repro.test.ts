import { chromium, type Browser } from "playwright-core";
import { expect, it, vi } from "vitest";
const moduleSlot = vi.hoisted(() => ({ value: {} as unknown }));
vi.mock("../src/browser/pw-ai-module.js", () => ({ getPwAiModule: async () => moduleSlot.value }));
import { closePlaywrightBrowserConnection } from "../src/browser/pw-session.js";
import { evaluateViaPlaywright } from "../src/browser/pw-tools-core.interactions.js";
import { withPlaywrightRouteContext } from "../src/browser/routes/agent.shared.js";
it.skipIf(process.env.BILLRPA_CONNECTION_REPRO !== "1")(
  "diagnose overlapping request teardown with real Chromium",
  async () => {
    const owner = await chromium.launch({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
      args: ["--remote-debugging-port=19237"],
    });
    let observer: Browser | undefined;
    try {
      observer = await chromium.connectOverCDP("http://127.0.0.1:19237");
      const page = await observer.contexts()[0].newPage();
      await page.goto("data:text/html,<title>BillRPA connection reproduction</title>");
      const session = await page.context().newCDPSession(page);
      const { targetInfo } = await session.send("Target.getTargetInfo");
      await session.detach();
      const targetId = targetInfo.targetId;
      const cdpUrl = "http://127.0.0.1:19237";
      moduleSlot.value = { closePlaywrightBrowserConnection };
      const ctx = {
        forProfile: () => ({ profile: { cdpUrl }, ensureTabAvailable: async () => ({ targetId }) }),
        mapTabError: () => null,
      } as never;
      const errors: unknown[] = [];
      const res = { status: () => res, json: (value: unknown) => errors.push(value) } as never;
      const req = { query: {}, params: {}, body: {} };
      const run = (fn: string) =>
        withPlaywrightRouteContext({
          ctx,
          res,
          req,
          targetId,
          feature: "evaluate",
          run: () => evaluateViaPlaywright({ cdpUrl, targetId, fn }),
        });
      const business = run(
        'async()=>{window.__billrpaStarted=true; await new Promise(r=>setTimeout(r,3000)); return "business-ok";}',
      );
      await expect.poll(() => page.evaluate("window.__billrpaStarted === true")).toBe(true);
      const probe = await run('()=>"probe-ok"');
      const result = await business;
      const alive = await page.evaluate("document.title");
      console.log(
        JSON.stringify({
          probe,
          result,
          errors,
          nativePageClosed: page.isClosed(),
          nativeTitle: alive,
        }),
      );
      expect(errors).toEqual([]);
      expect(result).toBe("business-ok");
    } finally {
      await closePlaywrightBrowserConnection();
      await observer?.close();
      await owner.close();
    }
  },
);
