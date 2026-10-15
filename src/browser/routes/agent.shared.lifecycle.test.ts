import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ close: vi.fn(async () => {}) }));
vi.mock("../pw-ai-module.js", () => ({
  getPwAiModule: async () => ({ closePlaywrightBrowserConnection: mocks.close }),
}));
import type { BrowserRouteContext } from "../server-context.js";
import { withPlaywrightRouteContext } from "./agent.shared.js";
import type { BrowserResponse } from "./types.js";

beforeEach(() => mocks.close.mockClear());

function request(cdpUrl: string, run: () => Promise<unknown>, keepAlive = false) {
  const ctx = {
    forProfile: () => ({
      profile: { cdpUrl },
      ensureTabAvailable: async () => ({ targetId: "A" }),
    }),
    mapTabError: () => null,
  } as unknown as BrowserRouteContext;
  const res = { status: () => res, json: vi.fn() } as unknown as BrowserResponse;
  return withPlaywrightRouteContext({
    req: { params: {}, query: {} },
    res,
    ctx,
    targetId: "A",
    feature: "evaluate",
    keepAlive,
    run,
  });
}

it("a completed probe cannot close the connection used by an overlapping business request", async () => {
  let finish!: () => void;
  const business = request(
    "http://local:9222/",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await request("http://local:9222", async () => "probe-ok");
  const closesDuringBusiness = mocks.close.mock.calls.length;
  finish();
  await business;
  expect(closesDuringBusiness).toBe(0);
  expect(mocks.close).toHaveBeenCalledTimes(1);
});

it("a failing overlapping request also leaves the active business connection open", async () => {
  let finish!: () => void;
  const business = request(
    "http://local:9223",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await request("http://local:9223", async () => {
    throw new Error("bad request");
  });
  const closesDuringBusiness = mocks.close.mock.calls.length;
  finish();
  await business;
  expect(closesDuringBusiness).toBe(0);
  expect(mocks.close).toHaveBeenCalledTimes(1);
});

it("an independent CDP profile can close while another profile is active", async () => {
  let finish!: () => void;
  const business = request(
    "http://local:9224",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await request("http://local:9225", async () => "ok");
  expect(mocks.close).toHaveBeenCalledWith({ cdpUrl: "http://local:9225" });
  finish();
  await business;
  expect(mocks.close).toHaveBeenCalledTimes(2);
});

it("a keep-alive hook finishing last retains its armed connection", async () => {
  let finish!: () => void;
  const hook = request(
    "http://local:9226",
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    true,
  );
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  await request("http://local:9226", async () => "probe-ok");
  finish();
  await hook;
  expect(mocks.close).not.toHaveBeenCalled();
  await request("http://local:9226", async () => "subsequent-action");
  expect(mocks.close).toHaveBeenCalledTimes(1);
});
