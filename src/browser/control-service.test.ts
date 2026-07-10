import { describe, expect, it, vi } from "vitest";

const {
  loadConfigMock,
  resolveBrowserConfigMock,
  ensureBrowserControlAuthMock,
  createBrowserRuntimeStateMock,
} = vi.hoisted(() => ({
  loadConfigMock: vi.fn(() => ({ browser: {} })),
  resolveBrowserConfigMock: vi.fn(() => ({
    enabled: true,
    controlPort: 18789,
    profiles: { chrome: {} },
  })),
  ensureBrowserControlAuthMock: vi.fn(async () => ({ generatedToken: false })),
  createBrowserRuntimeStateMock: vi.fn(async (params: { resolved: unknown; port: number }) => ({
    server: null,
    port: params.port,
    resolved: params.resolved,
    profiles: new Map(),
  })),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("./config.js", () => ({
  resolveBrowserConfig: resolveBrowserConfigMock,
}));

vi.mock("./control-auth.js", () => ({
  ensureBrowserControlAuth: ensureBrowserControlAuthMock,
}));

vi.mock("./runtime-lifecycle.js", () => ({
  createBrowserRuntimeState: createBrowserRuntimeStateMock,
  stopBrowserRuntime: vi.fn(async () => {}),
}));

import { startBrowserControlServiceFromConfig } from "./control-service.js";

describe("startBrowserControlServiceFromConfig", () => {
  it("starts in-process control without starting extension relay", async () => {
    await startBrowserControlServiceFromConfig();

    expect(createBrowserRuntimeStateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        ensureExtensionRelay: false,
      }),
    );
  });
});
