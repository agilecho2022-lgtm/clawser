import { beforeEach, describe, expect, it, vi } from "vitest";

const { ensureExtensionRelayForProfilesMock, stopKnownBrowserProfilesMock } = vi.hoisted(() => ({
  ensureExtensionRelayForProfilesMock: vi.fn(async () => {}),
  stopKnownBrowserProfilesMock: vi.fn(async () => {}),
}));

vi.mock("./server-lifecycle.js", () => ({
  ensureExtensionRelayForProfiles: ensureExtensionRelayForProfilesMock,
  stopKnownBrowserProfiles: stopKnownBrowserProfilesMock,
}));

vi.mock("./pw-ai-state.js", () => ({
  isPwAiLoaded: () => false,
}));

import { createBrowserRuntimeState } from "./runtime-lifecycle.js";

describe("createBrowserRuntimeState", () => {
  beforeEach(() => {
    ensureExtensionRelayForProfilesMock.mockClear();
  });

  it("can initialize status-only runtime state without starting extension relay", async () => {
    const state = await createBrowserRuntimeState({
      resolved: { profiles: { chrome: {} } },
      port: 18789,
      onWarn: vi.fn(),
      ensureExtensionRelay: false,
    } as never);

    expect(state.port).toBe(18789);
    expect(ensureExtensionRelayForProfilesMock).not.toHaveBeenCalled();
  });
});
