import { Command } from "commander";
import { afterEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ request: vi.fn(async () => ({ ok: true })) }));
vi.mock("./browser-cli-shared.js", () => ({ callBrowserRequest: calls.request }));
vi.mock("../runtime.js", () => ({
  defaultRuntime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));
import { registerBrowserManageCommands } from "./browser-cli-manage.js";
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
it.each([true, false])(
  "CLI close forwards scoped context for explicit target=%s",
  async (explicit) => {
    const trace = {
      close_id: "cli-close-1",
      initiator: "billrpa.screenshot_cleanup",
      initiator_pid: 123,
      task_id: "T",
      detail_id: "D",
    };
    vi.stubEnv("BILLRPA_CLOSE_CONTEXT", JSON.stringify(trace));
    const browser = new Command("browser");
    registerBrowserManageCommands(browser, () => ({ json: true }));
    await browser.parseAsync(["node", "browser", "close", ...(explicit ? ["TARGET"] : [])]);
    expect(calls.request).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        body: expect.objectContaining({ closeTrace: expect.objectContaining(trace) }),
      }),
      expect.anything(),
    );
  },
);
