import fs from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import express from "express";
import { chromium } from "playwright-core";
import { describe, expect, it } from "vitest";
import { withCdpSocket } from "./cdp.helpers.js";
import { browserAct } from "./client-actions-core.js";
import { resolveBrowserConfig } from "./config.js";
import {
  ensureChromeExtensionRelayServer,
  stopChromeExtensionRelayServer,
} from "./extension-relay.js";
import { closePlaywrightBrowserConnection } from "./pw-session.js";
import { clickViaPlaywright, waitForViaPlaywright } from "./pw-tools-core.interactions.js";
import { snapshotRoleViaPlaywright } from "./pw-tools-core.snapshot.js";
import { registerBrowserRoutes } from "./routes/index.js";
import { createBrowserRouteContext } from "./server-context.js";
import { installBrowserCommonMiddleware } from "./server-middleware.js";
import { getFreePort } from "./test-port.js";

const nativeEnabled = process.env.CLAWSER_NATIVE_BROWSER_TEST === "1";

describe.runIf(nativeEnabled)("server compatibility with the 0.1.3 native extension", () => {
  it(
    "keeps its attachment after a temporary session detach and completes an awaited Runtime beyond 30 seconds",
    { timeout: 120000 },
    async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawser-native-013-"));
      const port = await getFreePort();
      const extension = path.join(dir, "extension");
      await fs.cp(path.resolve("chrome-extension"), extension, { recursive: true });
      // Test fixture configuration only: use an isolated port before worker startup.
      // All production extension files remain untouched, including the published ZIP.
      const background = path.join(extension, "background.js");
      const source = await fs.readFile(background, "utf8");
      expect(source).toContain("const DEFAULT_PORT = 18792;");
      await fs.writeFile(
        background,
        source.replace("const DEFAULT_PORT = 18792;", `const DEFAULT_PORT = ${port};`),
      );
      const fixture = createServer((_req, res) => {
        res.setHeader("Content-Type", "text/html");
        res.end("<button onclick=\"document.body.dataset.clicked='yes'\">Test</button>");
      });
      await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
      const address = fixture.address();
      if (!address || typeof address === "string") {
        throw new Error("fixture port unavailable");
      }
      const cdpUrl = `http://127.0.0.1:${port}`;
      const record: Record<string, unknown> = {
        manifest: JSON.parse(await fs.readFile(path.join(extension, "manifest.json"), "utf8")),
        fixtureDefaultPortOverride: port,
      };
      let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
      let control: ReturnType<typeof createServer> | undefined;
      try {
        await ensureChromeExtensionRelayServer({ cdpUrl });
        context = await chromium.launchPersistentContext(path.join(dir, "profile"), {
          headless: true,
          executablePath: process.env.CLAWSER_NATIVE_BROWSER_EXECUTABLE,
          args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
        });
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(`http://127.0.0.1:${address.port}/`);
        const until = Date.now() + 10000;
        while (Date.now() < until) {
          const status = (await fetch(`${cdpUrl}/extension/status`, {
            headers: { "x-openclaw-relay-token": "CLAWSER" },
          }).then((r) => r.json())) as { connected: boolean };
          if (status.connected) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await withCdpSocket(`ws://127.0.0.1:${port}/cdp`, async (send) => {
          const attached = (await send("Clawser.attachTabs", {
            urlContains: `127.0.0.1:${address.port}`,
          })) as { tabs: Array<{ targetId: string }> };
          record.attach = attached;
          const inventory = (await send("Target.getTargets")) as {
            targetInfos: Array<{ targetId: string }>;
          };
          const targetId = inventory.targetInfos[0]?.targetId;
          expect(targetId).toBeTruthy();
          const first = (await send("Target.attachToTarget", { targetId, flatten: true })) as {
            sessionId: string;
          };
          const second = (await send("Target.attachToTarget", { targetId, flatten: true })) as {
            sessionId: string;
          };
          record.sessionIds = [first.sessionId, second.sessionId];
          record.detach = await send("Target.detachFromTarget", {
            sessionId: first.sessionId,
          }).then(
            (result) => ({ result }),
            (error) => ({ error: String(error) }),
          );
          await send("Runtime.evaluate", {
            targetId,
            expression: "document.querySelector('button').click()",
          });
          expect(await page.getAttribute("body", "data-clicked")).toBe("yes");
          record.snapshotAfterDetach = await send("Clawser.diagnosticSnapshot", {});
          record.attachmentUsableAfterDetach = true;
          const target = { cdpUrl, targetId };
          const duplicate = await context!.newPage();
          await duplicate.goto(page.url());
          const both = (await send("Clawser.attachTabs", {
            urlContains: `127.0.0.1:${address.port}`,
          })) as { tabs: Array<{ targetId: string }> };
          const duplicateTarget = both.tabs.find((tab) => tab.targetId !== targetId)!.targetId;
          const duplicateSnapshot = await snapshotRoleViaPlaywright({
            cdpUrl,
            targetId: duplicateTarget,
          });
          await page.evaluate(() => {
            delete document.body.dataset.clicked;
          });
          await clickViaPlaywright({
            cdpUrl,
            targetId: duplicateTarget,
            ref: Object.keys(duplicateSnapshot.refs)[0],
          });
          expect(await duplicate.getAttribute("body", "data-clicked")).toBe("yes");
          expect(await page.getAttribute("body", "data-clicked")).toBeNull();
          record.sameUrlExactTarget = { targetId, duplicateTarget, onlyRequestedPageClicked: true };
          for (const observed of [page, duplicate]) {
            expect(
              await observed.evaluate(() =>
                Object.getOwnPropertyNames(document).filter((key) =>
                  key.startsWith("__clawserTargetProof_"),
                ),
              ),
            ).toEqual([]);
          }
          const snapshot = await snapshotRoleViaPlaywright(target);
          await page.evaluate(() => {
            delete document.body.dataset.clicked;
          });
          await expect(
            clickViaPlaywright({ cdpUrl, targetId: "MISSING-NATIVE-TARGET", ref: "e1" }),
          ).rejects.toThrow(/tab not found/i);
          expect(await page.getAttribute("body", "data-clicked")).toBeNull();
          const ref = Object.entries(snapshot.refs).find(([, info]) => info.role === "button")![0];
          await clickViaPlaywright({ ...target, ref });
          expect(await page.getAttribute("body", "data-clicked")).toBe("yes");
          await expect(
            waitForViaPlaywright({ ...target, fn: "false", timeoutMs: 600 }),
          ).rejects.toThrow(/600ms/);
          record.playwrightActionAndExplicitTargetChecksPassed = true;
          const state = {
            port: 0,
            profiles: new Map(),
            resolved: resolveBrowserConfig({
              defaultProfile: "native-test",
              profiles: { "native-test": { driver: "extension", cdpUrl, color: "#123456" } },
            }),
          };
          const app = express();
          const controlRequests: string[] = [];
          record.controlRequests = controlRequests;
          app.use((req, _res, next) => {
            controlRequests.push(req.url);
            next();
          });
          installBrowserCommonMiddleware(app);
          registerBrowserRoutes(app, createBrowserRouteContext({ getState: () => state }));
          control = createServer(app);
          await new Promise<void>((resolve) => control!.listen(0, "127.0.0.1", resolve));
          const controlAddress = control.address();
          if (!controlAddress || typeof controlAddress === "string") {
            throw new Error("control port unavailable");
          }
          const configPath = path.join(dir, "clawser.json");
          await fs.writeFile(
            configPath,
            JSON.stringify({
              gateway: { port: controlAddress.port - 2, auth: { mode: "none" } },
              browser: {
                defaultProfile: "native-test",
                profiles: { "native-test": { driver: "extension", cdpUrl, color: "#123456" } },
              },
            }),
          );
          const priorConfig = process.env.OPENCLAW_CONFIG_PATH;
          const priorRuntimeLog = process.env.OPENCLAW_TEST_RUNTIME_LOG;
          const priorConsole = process.env.OPENCLAW_TEST_CONSOLE;
          process.env.OPENCLAW_CONFIG_PATH = configPath;
          process.env.OPENCLAW_TEST_RUNTIME_LOG = "1";
          process.env.OPENCLAW_TEST_CONSOLE = "1";
          try {
            const require = createRequire(import.meta.url);
            const Browser = require(path.resolve("../billrpa/script/browser-clawser.js"));
            const { bindTaskBrowser } = require(path.resolve("../billrpa/script/task-browser.js"));
            const rawClient = new Browser({
              bin: path.resolve("clawser.mjs"),
              profile: "native-test",
              commandLog() {},
            });
            const client = bindTaskBrowser(rawClient, targetId);
            record.directTabs = await fetch(
              `http://127.0.0.1:${controlAddress.port}/tabs?profile=native-test`,
            ).then((response) => response.json());
            record.rawClientTabs = await rawClient.runBrowser(["tabs"]);
            record.clientTabs = await client.tabs();
            expect(record.clientTabs).toEqual(
              expect.arrayContaining([expect.objectContaining({ targetId })]),
            );
            const conditionTimeout = client
              .waitForElement("#never-created", 500)
              .catch((error: { code: string; message: string }) => {
                record.conditionTimeout = { code: error.code, message: error.message };
                throw error;
              });
            await expect(conditionTimeout).rejects.toMatchObject({
              code: "BROWSER_WAIT_TIMEOUT",
            });
            await page.evaluate(() => {
              setTimeout(() => {
                const node = document.createElement("div");
                node.id = "late-ready";
                document.body.appendChild(node);
                node.textContent = "Ready";
              }, 62000);
            });
            const started = Date.now();
            record.clientLongWait = await client.waitForElement("#late-ready", 120000);
            record.clientLongWaitElapsedMs = Date.now() - started;
            expect(record.clientLongWait).toMatchObject({ ok: true, targetId });
            expect(record.clientLongWaitElapsedMs).toBeGreaterThan(60000);
            record.publicShortWait = await browserAct(`http://127.0.0.1:${controlAddress.port}`, {
              kind: "wait",
              targetId,
              fn: "true",
              timeoutMs: 1000,
            });
          } finally {
            for (const [key, value] of [
              ["OPENCLAW_CONFIG_PATH", priorConfig],
              ["OPENCLAW_TEST_RUNTIME_LOG", priorRuntimeLog],
              ["OPENCLAW_TEST_CONSOLE", priorConsole],
            ]) {
              if (value === undefined) {
                delete process.env[key!];
              } else {
                process.env[key!] = value;
              }
            }
          }
        });
      } finally {
        if (process.env.BILLRPA_SERVER_STABILITY_EVIDENCE_DIR) {
          await fs.writeFile(
            path.join(
              process.env.BILLRPA_SERVER_STABILITY_EVIDENCE_DIR,
              "native-013-characterization.json",
            ),
            JSON.stringify(record, null, 2) + "\n",
          );
        }
        if (control) {
          control.closeAllConnections();
          await new Promise<void>((resolve, reject) =>
            control!.close((error) => (error ? reject(error) : resolve())),
          );
        }
        await closePlaywrightBrowserConnection({ cdpUrl });
        await context?.close();
        await stopChromeExtensionRelayServer({ cdpUrl });
        await new Promise<void>((resolve, reject) =>
          fixture.close((error) => (error ? reject(error) : resolve())),
        );
        await fs.rm(dir, { recursive: true, force: true });
      }
    },
  );
});
