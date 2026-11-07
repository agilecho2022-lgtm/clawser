import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { expect, it, vi } from "vitest";
import { browserAct } from "./client-actions-core.js";

it("keeps the public action HTTP request alive inside an explicitly longer wait budget", async () => {
  let accepted!: (response: ServerResponse) => void;
  const received = new Promise<ServerResponse>((resolve) => {
    accepted = resolve;
  });
  const server = createServer((_request, response) => {
    accepted(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fixture port unavailable");
  }
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const pending = browserAct(`http://127.0.0.1:${address.port}`, {
    kind: "wait",
    fn: "false",
    targetId: "tab-1",
    timeoutMs: 60000,
  });
  void pending.catch(() => {});
  try {
    const response = await received;
    await vi.advanceTimersByTimeAsync(20_001);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ ok: true, targetId: "tab-1" }));
    await expect(pending).resolves.toMatchObject({ ok: true, targetId: "tab-1" });
  } finally {
    vi.useRealTimers();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
