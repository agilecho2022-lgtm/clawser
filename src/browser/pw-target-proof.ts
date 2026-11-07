import { randomUUID } from "node:crypto";
import type { Browser, Page } from "playwright-core";
import {
  appendCdpPath,
  fetchJson,
  normalizeCdpHttpBaseForJsonEndpoints,
  withCdpSocket,
} from "./cdp.helpers.js";
import { getChromeWebSocketUrl } from "./chrome.js";
import {
  BrowserTabNotFoundError,
  BrowserTargetAmbiguousError,
  BrowserTargetUnavailableError,
} from "./errors.js";
import { assertTargetInventory } from "./target-inventory.js";

// A Playwright Page retains its native target across document navigations.
const bindings = new WeakMap<Page, { cdpUrl: string; targetId: string }>();

export async function findExtensionPageByNativeTarget(
  browser: Browser,
  cdpUrl: string,
  targetId: string,
): Promise<Page> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      reject(new BrowserTargetUnavailableError());
    }, 2500);
  });
  const work = async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const base = normalizeCdpHttpBaseForJsonEndpoints(cdpUrl);
      let targets: Array<{ id: string }>;
      try {
        targets = await fetchJson(appendCdpPath(base, "/json/list"), 1500);
      } catch {
        throw new BrowserTargetUnavailableError(
          "Target inventory is unavailable; page absence is not established.",
        );
      }
      assertTargetInventory(targets);
      const entries = targets.filter((target) => target.id === targetId);
      if (!entries.length) {
        throw new BrowserTabNotFoundError();
      }
      if (entries.length > 1) {
        throw new BrowserTargetAmbiguousError(
          "Multiple inventory entries claim the native target id.",
        );
      }
      const pages = browser
        .contexts()
        .flatMap((context) => context.pages())
        .filter((page) => !page.isClosed());
      const cached = pages.find((page) => {
        const identity = bindings.get(page);
        return identity?.cdpUrl === cdpUrl && identity.targetId === targetId;
      });
      if (expired) {
        throw new BrowserTargetUnavailableError();
      }
      if (cached) {
        return cached;
      }
      const wsUrl = await getChromeWebSocketUrl(cdpUrl, 1500);
      if (!wsUrl) {
        throw new BrowserTargetUnavailableError();
      }
      const key = `__clawserTargetProof_${randomUUID().replaceAll("-", "")}`,
        nonce = randomUUID();
      try {
        const match = await withCdpSocket(
          wsUrl,
          async (send) => {
            // Exact targetId is already supported by 0.1.3; no new attachment or
            // session alias. Non-enumerable Document metadata cannot alter the DOM.
            const install = `(() => { const owner = document; const key = ${JSON.stringify(key)}; Object.defineProperty(owner,key,{value:${JSON.stringify(nonce)},configurable:true}); setTimeout(() => { delete owner[key]; },5000); return true; })()`;
            const response = (await Promise.race([
              send("Runtime.evaluate", {
                targetId,
                expression: install,
                returnByValue: true,
                timeout: 1000,
              }),
              deadline,
            ])) as { result?: { value?: unknown }; exceptionDetails?: unknown };
            if (response.exceptionDetails || response.result?.value !== true) {
              throw new BrowserTargetUnavailableError();
            }
            try {
              // A matching Document is sufficient proof. An unrelated stalled
              // renderer must not delay an already-proved target. Pending reads
              // are read-only and cannot publish a binding after this scope exits.
              return await Promise.race([
                Promise.any(
                  pages.map(async (page) => {
                    const yes = await page.evaluate(
                      ({ key, nonce }) =>
                        (document as unknown as Record<string, unknown>)[key] === nonce,
                      { key, nonce },
                    );
                    if (!yes || page.isClosed()) {
                      throw new Error("Different native target");
                    }
                    return page;
                  }),
                ).catch(() => undefined),
                deadline,
              ]);
            } finally {
              await Promise.race([
                send("Runtime.evaluate", {
                  targetId,
                  expression: `delete document[${JSON.stringify(key)}]`,
                  returnByValue: true,
                  timeout: 1000,
                }),
                deadline,
              ]).catch(() => {});
            }
          },
          { handshakeTimeoutMs: 1500 },
        );
        if (expired) {
          throw new BrowserTargetUnavailableError();
        }
        if (
          match &&
          !match.isClosed() &&
          browser.contexts().some((context) => context.pages().includes(match))
        ) {
          bindings.set(match, { cdpUrl, targetId });
          return match;
        }
      } catch (error) {
        if (error instanceof BrowserTargetAmbiguousError) {
          throw error;
        }
        if (expired) {
          throw new BrowserTargetUnavailableError();
        }
      }
      if (!expired && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
    }
    throw new BrowserTargetUnavailableError(
      "Native target exists, but its Playwright Page identity could not be established.",
    );
  };
  try {
    return await Promise.race([work(), deadline]);
  } finally {
    clearTimeout(timer);
    expired = true;
  }
}
