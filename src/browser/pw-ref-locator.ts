import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import type { ElementHandle, Locator } from "playwright-core";

type RefElement = ElementHandle<HTMLElement | SVGElement>;
const scopes = new WeakMap<Locator, () => void>();

/** Pin ref actions to actual nodes: Locator's normal retry may resolve in a replacement document. */
export function bindSnapshotLocator(locator: Locator, assertCurrent: () => void): Locator {
  const withElement = async <T>(
    timeout: number | undefined,
    action: (element: RefElement, remaining: () => number) => Promise<T>,
  ): Promise<T> => {
    assertCurrent();
    const budget = timeout ?? 30_000;
    const deadline = budget ? Date.now() + budget : undefined;
    const remaining = () => {
      if (deadline === undefined) {
        return 0;
      }
      const value = deadline - Date.now();
      if (value <= 0) {
        throw new Error(`Ref action timed out after ${budget}ms`);
      }
      return value;
    };
    const element = await locator.elementHandle({ timeout: budget });
    try {
      assertCurrent();
      if (!element) {
        throw new Error("Snapshot ref no longer resolves to an element. Run a new snapshot.");
      }
      return await action(element, remaining);
    } catch (error) {
      assertCurrent();
      throw error;
    } finally {
      await element?.dispose().catch(() => {});
    }
  };

  const bound = new Proxy(locator, {
    get(target, property, receiver) {
      switch (property) {
        case "click":
          return (options: Parameters<Locator["click"]>[0] = {}) =>
            withElement(options.timeout, (element, remaining) =>
              element.click({ ...options, timeout: remaining() }),
            );
        case "dblclick":
          return (options: Parameters<Locator["dblclick"]>[0] = {}) =>
            withElement(options.timeout, (element, remaining) =>
              element.dblclick({ ...options, timeout: remaining() }),
            );
        case "hover":
          return (options: Parameters<Locator["hover"]>[0] = {}) =>
            withElement(options.timeout, (element, remaining) =>
              element.hover({ ...options, timeout: remaining() }),
            );
        case "fill":
          return (value: string, options: Parameters<Locator["fill"]>[1] = {}) =>
            withElement(options.timeout, (element, remaining) =>
              element.fill(value, { ...options, timeout: remaining() }),
            );
        case "press":
          return (key: string, options: Parameters<Locator["press"]>[1] = {}) =>
            withElement(options.timeout, (element, remaining) =>
              element.press(key, { ...options, timeout: remaining() }),
            );
        case "type":
          return (value: string, options: Parameters<Locator["type"]>[1] = {}) =>
            withElement(options.timeout, async (element, remaining) => {
              // Re-focus the pinned node between delayed characters; navigation must
              // not leave a browser-side typing loop running against a new focus.
              for (const character of value) {
                assertCurrent();
                await element.type(character, { ...options, delay: 0, timeout: remaining() });
                if (options.delay) {
                  await sleep(options.delay);
                }
              }
            });
        case "selectOption":
          return (
            values: Parameters<Locator["selectOption"]>[0],
            options: Parameters<Locator["selectOption"]>[1] = {},
          ) =>
            withElement(options.timeout, (element, remaining) =>
              element.selectOption(values, { ...options, timeout: remaining() }),
            );
        case "setChecked":
          return (checked: boolean, options: Parameters<Locator["setChecked"]>[1] = {}) =>
            withElement(options.timeout, (element, remaining) =>
              element.setChecked(checked, { ...options, timeout: remaining() }),
            );
        case "scrollIntoViewIfNeeded":
          return (options: Parameters<Locator["scrollIntoViewIfNeeded"]>[0] = {}) =>
            withElement(options.timeout, (element, remaining) =>
              element.scrollIntoViewIfNeeded({ timeout: remaining() }),
            );
        case "screenshot":
          return (options: Parameters<Locator["screenshot"]>[0] = {}) =>
            withElement(options.timeout, (element, remaining) =>
              element.screenshot({ ...options, timeout: remaining() }),
            );
        case "evaluate":
          return (
            fn: Parameters<Locator["evaluate"]>[0],
            arg?: unknown,
            options?: { timeout?: number },
          ) => withElement(options?.timeout, (element) => element.evaluate(fn, arg));
        case "dragTo":
          return (destination: Locator, options: Parameters<Locator["dragTo"]>[1] = {}) =>
            withElement(options.timeout, async (source, remaining) => {
              const assertDestination = scopes.get(destination) ?? assertCurrent;
              assertDestination();
              const end = await destination.elementHandle({ timeout: remaining() });
              const marker = `data-clawser-drag-${randomUUID()}`;
              try {
                assertCurrent();
                assertDestination();
                if (!end) {
                  throw new Error("Drag destination is no longer available");
                }
                const frame = await source.ownerFrame();
                if (!frame || frame !== (await end.ownerFrame())) {
                  throw new Error("Drag refs must belong to the same frame");
                }
                // ElementHandle has no dragTo API. Unique temporary node markers keep
                // Playwright's native drag retry on these nodes, never new-page names.
                await source.evaluate((node, name) => node.setAttribute(name, "source"), marker);
                await end.evaluate((node, name) => node.setAttribute(name, "destination"), marker);
                assertCurrent();
                assertDestination();
                await frame
                  .locator(`[${marker}="source"]`)
                  .dragTo(frame.locator(`[${marker}="destination"]`), {
                    ...options,
                    timeout: remaining(),
                  });
              } finally {
                await source
                  .evaluate((node, name) => node.removeAttribute(name), marker)
                  .catch(() => {});
                await end
                  ?.evaluate((node, name) => node.removeAttribute(name), marker)
                  .catch(() => {});
                await end?.dispose().catch(() => {});
              }
            });
        default:
          return Reflect.get(target, property, receiver);
      }
    },
  });
  scopes.set(bound, assertCurrent);
  return bound;
}
