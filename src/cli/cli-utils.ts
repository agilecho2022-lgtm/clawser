import type { RuntimeEnv } from "../runtime.js";

export async function runCommandWithRuntime(
  _runtime: RuntimeEnv,
  action: () => Promise<void>,
  onError: (err: unknown) => void,
): Promise<void> {
  try {
    await action();
  } catch (err) {
    onError(err);
  }
}
