import { afterEach, expect, it, vi } from "vitest";
import { createDocumentWaitPredicate } from "./wait-predicate.js";

afterEach(() => vi.unstubAllGlobals());
it.each([
  "window.ready",
  "window.ready;",
  "() => window.ready",
  "return window.ready;",
  "async () => window.ready",
])("polls false then true for %s", async (source) => {
  const document = {},
    window = { ready: false };
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", window);
  const state = { document },
    predicate = createDocumentWaitPredicate(source);
  expect(predicate(state)).toBe(false);
  await Promise.resolve();
  expect(predicate(state)).toBe(false);
  window.ready = true;
  let value = false;
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
    value ||= predicate(state);
  }
  expect(value).toBe(true);
});
it("rejects a replacement Document even after an async predicate settles true", async () => {
  const document = {};
  vi.stubGlobal("document", document);
  const predicate = createDocumentWaitPredicate("async () => true"),
    state = { document };
  expect(predicate(state)).toBe(false);
  await Promise.resolve();
  vi.stubGlobal("document", {});
  expect(() => predicate(state)).toThrow(/document changed/);
});
it("does not execute supplied code during construction", () => {
  vi.stubGlobal("reviewSideEffect", false);
  createDocumentWaitPredicate("(() => { globalThis.reviewSideEffect = true; return true; })()");
  expect((globalThis as unknown as { reviewSideEffect: boolean }).reviewSideEffect).toBe(false);
});
