import { afterAll, afterEach, vi } from "vitest";
import { withIsolatedTestHome } from "./test-env.js";

process.env.VITEST = "true";

const TEST_PROCESS_MAX_LISTENERS = 128;
if (process.getMaxListeners() > 0 && process.getMaxListeners() < TEST_PROCESS_MAX_LISTENERS) {
  process.setMaxListeners(TEST_PROCESS_MAX_LISTENERS);
}

const testEnv = withIsolatedTestHome();
afterAll(() => testEnv.cleanup());

const { installProcessWarningFilter } = await import("../src/infra/warning-filter.js");
installProcessWarningFilter();

afterEach(() => {
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
});
