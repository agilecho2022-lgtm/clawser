import { Script } from "node:vm";

function parsesAsExpression(source: string): boolean {
  try {
    // Parse only: caller-supplied code executes in the browser, never in Node.
    new Script(`(${source})`);
    return true;
  } catch {
    return false;
  }
}

type WaitState = {
  document: unknown;
  predicate?: () => unknown;
  pending?: boolean;
  settled?: { value: unknown } | { error: unknown };
};

export function createDocumentWaitPredicate(source: string): (state: WaitState) => boolean {
  const text = source.trim();
  const expression = text.replace(/;+\s*$/, "").trimEnd();
  const predicate = parsesAsExpression(expression)
    ? `() => { const value = (${expression}); return typeof value === "function" ? value() : value; }`
    : `async () => { ${text}\n }`;
  // Construct the function without executing it. Async predicates are polled so a
  // pending result cannot bypass the original document check after navigation.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- Compile only; Playwright executes this function in the page under the evaluate-enabled contract.
  return new Function(
    "state",
    `
    if (state.document !== document) throw new Error("Wait predicate document changed");
    state.predicate ??= (${predicate});
    if (state.settled) {
      const settled = state.settled;
      delete state.settled;
      if ("error" in settled) throw settled.error;
      if (settled.value) return true;
    }
    if (state.pending) return false;
    const value = state.predicate();
    if (!value || typeof value.then !== "function") return !!value;
    state.pending = true;
    Promise.resolve(value).then(
      value => { state.settled = { value }; delete state.pending; },
      error => { state.settled = { error }; delete state.pending; }
    );
    return false;
  `,
  ) as (state: WaitState) => boolean;
}
