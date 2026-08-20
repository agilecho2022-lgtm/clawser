import { createServer } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { captureEnv } from "../test-utils/env.js";
import {
  ensureChromeExtensionRelayServer,
  getChromeExtensionRelayAuthHeaders,
  stopChromeExtensionRelayServer,
} from "./extension-relay.js";
import { getFreePort } from "./test-port.js";

const RELAY_MESSAGE_TIMEOUT_MS = 1_200;
const RELAY_LIST_MATCH_TIMEOUT_MS = 1_000;
const RELAY_TEST_TIMEOUT_MS = 10_000;
const RELAY_AUTH_TOKEN = "CLAWSER";

function waitForOpen(ws: WebSocket) {
  return new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
}

function waitForError(ws: WebSocket) {
  return new Promise<Error>((resolve, reject) => {
    ws.once("error", (err) => resolve(err instanceof Error ? err : new Error(String(err))));
    ws.once("open", () => reject(new Error("expected websocket error")));
  });
}

function waitForClose(ws: WebSocket, timeoutMs = RELAY_MESSAGE_TIMEOUT_MS) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("timeout"));
    }, timeoutMs);
    ws.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
}

function relayAuthHeaders(url: string) {
  return getChromeExtensionRelayAuthHeaders(url);
}

function extensionWsUrl(port: number | string) {
  return `ws://127.0.0.1:${port}/extension?token=${encodeURIComponent(RELAY_AUTH_TOKEN)}`;
}

function createMessageQueue(ws: WebSocket) {
  const queue: string[] = [];
  let waiter: ((value: string) => void) | null = null;
  let waiterReject: ((err: Error) => void) | null = null;
  let waiterTimer: NodeJS.Timeout | null = null;

  const flushWaiter = (value: string) => {
    if (!waiter) {
      return false;
    }
    const resolve = waiter;
    waiter = null;
    const reject = waiterReject;
    waiterReject = null;
    if (waiterTimer) {
      clearTimeout(waiterTimer);
    }
    waiterTimer = null;
    if (reject) {
      // no-op (kept for symmetry)
    }
    resolve(value);
    return true;
  };

  ws.on("message", (data) => {
    const text =
      typeof data === "string"
        ? data
        : Buffer.isBuffer(data)
          ? data.toString("utf8")
          : Array.isArray(data)
            ? Buffer.concat(data).toString("utf8")
            : Buffer.from(data).toString("utf8");
    if (flushWaiter(text)) {
      return;
    }
    queue.push(text);
  });

  ws.on("error", (err) => {
    if (!waiterReject) {
      return;
    }
    const reject = waiterReject;
    waiterReject = null;
    waiter = null;
    if (waiterTimer) {
      clearTimeout(waiterTimer);
    }
    waiterTimer = null;
    reject(err instanceof Error ? err : new Error(String(err)));
  });

  const next = (timeoutMs = RELAY_MESSAGE_TIMEOUT_MS) =>
    new Promise<string>((resolve, reject) => {
      const existing = queue.shift();
      if (existing !== undefined) {
        return resolve(existing);
      }
      waiter = resolve;
      waiterReject = reject;
      waiterTimer = setTimeout(() => {
        waiter = null;
        waiterReject = null;
        waiterTimer = null;
        reject(new Error("timeout"));
      }, timeoutMs);
    });

  return { next };
}

// performHandshakeWithQueue 用已注册好 listener 的消息队列完成协议握手：
// 等 relay 的 connect.challenge，回 connect 请求（声明 minProtocol–maxProtocol）。
// queue 必须在 waitForOpen 之前创建——relay 在连接建立后立即发 challenge，
// open 之后才注册 listener 会因回环速度极快而丢失该消息。
async function performHandshakeWithQueue(
  ws: WebSocket,
  queue: ReturnType<typeof createMessageQueue>,
  minProtocol = 3,
  maxProtocol = 3,
): Promise<{ ok: boolean; error?: string }> {
  const challengeRaw = await queue.next();
  const challenge = JSON.parse(challengeRaw) as {
    type?: string;
    event?: string;
    payload?: { nonce?: string };
  };
  if (challenge?.type !== "event" || challenge?.event !== "connect.challenge") {
    throw new Error(`expected connect.challenge, got ${challengeRaw}`);
  }
  ws.send(
    JSON.stringify({
      type: "req",
      id: "handshake-1",
      method: "connect",
      params: {
        minProtocol,
        maxProtocol,
        client: { id: "test-extension", version: "1.0.0", platform: "chrome-extension" },
        nonce: challenge.payload?.nonce,
      },
    }),
  );
  const resRaw = await queue.next();
  const res = JSON.parse(resRaw) as { type?: string; ok?: boolean; error?: { message?: string } };
  return { ok: res?.ok === true, error: res?.error?.message };
}

// connectExtensionAt 建立扩展连接并完成协议握手（默认声明协议 3–3）。
// useHeaders=true 时用 relayAuthHeaders（与 extensionWsUrl 的 token 等效）。
async function connectExtensionAt(port: number | string, useHeaders = false): Promise<WebSocket> {
  const ws = useHeaders
    ? new WebSocket(`ws://127.0.0.1:${port}/extension`, {
        headers: relayAuthHeaders(`ws://127.0.0.1:${port}/extension`),
      })
    : new WebSocket(extensionWsUrl(port));
  const queue = createMessageQueue(ws);
  await waitForOpen(ws);
  const handshake = await performHandshakeWithQueue(ws, queue);
  if (!handshake.ok) {
    ws.close();
    throw new Error(`extension handshake failed: ${handshake.error}`);
  }
  return ws;
}

// connectExtensionExpectRejection 用于拒绝场景：连接、完成握手（声明不匹配的版本）、
// 返回握手结果与连接（调用方自行断言 result.ok === false）。
async function connectExtensionExpectRejection(
  port: number | string,
  minProtocol: number,
  maxProtocol: number,
): Promise<{ ws: WebSocket; result: { ok: boolean; error?: string } }> {
  const ws = new WebSocket(extensionWsUrl(port));
  const queue = createMessageQueue(ws);
  await waitForOpen(ws);
  const result = await performHandshakeWithQueue(ws, queue, minProtocol, maxProtocol);
  return { ws, result };
}

async function waitForListMatch<T>(
  fetchList: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = RELAY_LIST_MATCH_TIMEOUT_MS,
  intervalMs = 20,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let latest: T | null = null;
  while (Date.now() <= deadline) {
    latest = await fetchList();
    if (predicate(latest)) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("timeout waiting for list match");
}

describe("chrome extension relay server", () => {
  let cdpUrl = "";
  let sharedCdpUrl = "";
  let envSnapshot: ReturnType<typeof captureEnv>;

  beforeEach(() => {
    envSnapshot = captureEnv([
      "OPENCLAW_EXTENSION_RELAY_RECONNECT_GRACE_MS",
      "OPENCLAW_EXTENSION_RELAY_COMMAND_RECONNECT_WAIT_MS",
      "OPENCLAW_EXTENSION_RELAY_HANDSHAKE_ERROR_TTL_MS",
    ]);
    delete process.env.OPENCLAW_EXTENSION_RELAY_RECONNECT_GRACE_MS;
    delete process.env.OPENCLAW_EXTENSION_RELAY_COMMAND_RECONNECT_WAIT_MS;
    delete process.env.OPENCLAW_EXTENSION_RELAY_HANDSHAKE_ERROR_TTL_MS;
  });

  afterEach(async () => {
    if (cdpUrl) {
      await stopChromeExtensionRelayServer({ cdpUrl }).catch(() => {});
      cdpUrl = "";
    }
    envSnapshot.restore();
  });

  afterAll(async () => {
    if (!sharedCdpUrl) {
      return;
    }
    await stopChromeExtensionRelayServer({ cdpUrl: sharedCdpUrl }).catch(() => {});
    sharedCdpUrl = "";
  });

  async function ensureSharedRelayServer() {
    if (sharedCdpUrl) {
      return sharedCdpUrl;
    }
    const port = await getFreePort();
    sharedCdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl: sharedCdpUrl });
    return sharedCdpUrl;
  }

  async function startRelayWithExtension() {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });
    const ext = await connectExtensionAt(port);
    return { port, ext };
  }

  it("accepts fixed-token extension and CDP websocket connections", async () => {
    const { port, ext } = await startRelayWithExtension();
    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/cdp`),
    });

    await waitForOpen(cdp);
    expect(ext.readyState).toBe(WebSocket.OPEN);
    expect(cdp.readyState).toBe(WebSocket.OPEN);

    cdp.close();
    ext.close();
  });

  it("serves authenticated CDP discovery endpoints", async () => {
    const { port, ext } = await startRelayWithExtension();
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = relayAuthHeaders(baseUrl);

    const version = (await fetch(`${baseUrl}/json/version`, { headers }).then((r) => r.json())) as {
      Browser?: string;
      "Protocol-Version"?: string;
      webSocketDebuggerUrl?: string;
    };
    expect(version.Browser).toBe("Clawser/extension-relay");
    expect(version["Protocol-Version"]).toBe("1.3");
    expect(String(version.webSocketDebuggerUrl ?? "")).toContain("/cdp");

    const list = (await fetch(`${baseUrl}/json/list`, { headers }).then((r) =>
      r.json(),
    )) as unknown[];
    expect(Array.isArray(list)).toBe(true);

    ext.close();
  });

  it("advertises CDP WS only when extension is connected", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const v1 = (await fetch(`${cdpUrl}/json/version`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as {
      webSocketDebuggerUrl?: string;
    };
    expect(v1.webSocketDebuggerUrl).toBeUndefined();

    const ext = await connectExtensionAt(port);

    const v2 = (await fetch(`${cdpUrl}/json/version`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as {
      webSocketDebuggerUrl?: string;
    };
    expect(String(v2.webSocketDebuggerUrl ?? "")).toContain(`/cdp`);

    ext.close();
  });

  it("uses the fixed relay token only for known relay ports", async () => {
    const port = await getFreePort();
    const unknown = getChromeExtensionRelayAuthHeaders(`http://127.0.0.1:${port}`);
    expect(unknown).toEqual({});

    const sharedUrl = await ensureSharedRelayServer();

    const headers = getChromeExtensionRelayAuthHeaders(sharedUrl);
    expect(Object.keys(headers)).toContain("x-openclaw-relay-token");
    expect(headers["x-openclaw-relay-token"]).toBe(RELAY_AUTH_TOKEN);
  });

  it("rejects CDP access without relay auth token", async () => {
    const sharedUrl = await ensureSharedRelayServer();
    const sharedPort = new URL(sharedUrl).port;

    const res = await fetch(`${sharedUrl}/json/version`);
    expect(res.status).toBe(401);

    const cdp = new WebSocket(`ws://127.0.0.1:${sharedPort}/cdp`);
    const err = await waitForError(cdp);
    expect(err.message).toContain("401");
  });

  it("returns 400 for malformed percent-encoding in target action routes", async () => {
    const sharedUrl = await ensureSharedRelayServer();

    const res = await fetch(`${sharedUrl}/json/activate/%E0%A4%A`, {
      headers: relayAuthHeaders(sharedUrl),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("invalid targetId encoding");
  });

  it("deduplicates concurrent relay starts for the same requested port", async () => {
    const sharedUrl = await ensureSharedRelayServer();
    const port = Number(new URL(sharedUrl).port);
    const [first, second] = await Promise.all([
      ensureChromeExtensionRelayServer({ cdpUrl: sharedUrl }),
      ensureChromeExtensionRelayServer({ cdpUrl: sharedUrl }),
    ]);
    expect(first).toBe(second);
    expect(first.port).toBe(port);
  });

  it("allows CORS preflight from chrome-extension origins", async () => {
    const sharedUrl = await ensureSharedRelayServer();

    const origin = "chrome-extension://abcdefghijklmnop";
    const res = await fetch(`${sharedUrl}/json/version`, {
      method: "OPTIONS",
      headers: {
        Origin: origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "x-openclaw-relay-token",
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("access-control-allow-headers") ?? "").toContain(
      "x-openclaw-relay-token",
    );
  });

  it("rejects CORS preflight from non-extension origins", async () => {
    const sharedUrl = await ensureSharedRelayServer();

    const res = await fetch(`${sharedUrl}/json/version`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.com",
        "Access-Control-Request-Method": "GET",
      },
    });

    expect(res.status).toBe(403);
  });

  it("returns CORS headers on JSON responses for extension origins", async () => {
    const sharedUrl = await ensureSharedRelayServer();

    const origin = "chrome-extension://abcdefghijklmnop";
    const res = await fetch(`${sharedUrl}/json/version`, {
      headers: {
        Origin: origin,
        ...relayAuthHeaders(sharedUrl),
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
  });

  it("rejects extension websocket access without relay auth token", async () => {
    const sharedUrl = await ensureSharedRelayServer();
    const sharedPort = new URL(sharedUrl).port;

    const ext = new WebSocket(`ws://127.0.0.1:${sharedPort}/extension`);
    const err = await waitForError(ext);
    expect(err.message).toContain("401");
  });

  it("rejects a second live extension connection with 409", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const ext1 = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/extension`),
    });
    await waitForOpen(ext1);

    const ext2 = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/extension`),
    });
    const err = await waitForError(ext2);
    expect(err.message).toContain("409");

    ext1.close();
  });

  it("allows immediate reconnect when prior extension socket is closing", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const ext1 = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/extension`),
    });
    await waitForOpen(ext1);
    const ext1Closed = new Promise<void>((resolve) => ext1.once("close", () => resolve()));

    ext1.close();
    const ext2 = await connectExtensionAt(port, true);
    await ext1Closed;

    const status = (await fetch(`${cdpUrl}/extension/status`).then((r) => r.json())) as {
      connected?: boolean;
    };
    expect(status.connected).toBe(true);

    ext2.close();
  });

  it("rejects handshake with mismatched protocol version and reports the reason", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const { ws: ext, result } = await connectExtensionExpectRejection(port, 999, 999);
    expect(result.ok).toBe(false);
    expect(result.error ?? "").toContain("扩展协议版本不匹配");
    expect(result.error ?? "").toContain("请升级 BillRPA 客户端");

    await waitForClose(ext);

    const status = (await fetch(`${cdpUrl}/extension/status`).then((r) => r.json())) as {
      connected?: boolean;
      error?: string;
    };
    expect(status.connected).toBe(false);
    expect(status.error ?? "").toContain("扩展协议版本不匹配");

    ext.close();
  });

  it("rejects handshake with missing protocol version", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const { ws: ext, result } = await connectExtensionExpectRejection(port, Number.NaN, Number.NaN);
    expect(result.ok).toBe(false);

    await waitForClose(ext);
  });

  // C25 版本偏斜防护：扩展独立发版、由 Edge 自动更新，协议升级后可能发出第二个
  // type:"req" 方法（如 v4 新命令）。老 relay 必须忽略而不是当作握手请求处理——
  // 否则会回 "invalid nonce"，把「版本不匹配」的诊断带偏成认证问题。握手守卫的
  // method 判断不能省，这里从「未握手连接」方向覆盖：错误实现（只看 type）会立即
  // 回 invalid nonce，正确实现则无任何响应。
  it("ignores non-connect req messages instead of treating them as handshake", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const ws = new WebSocket(extensionWsUrl(port));
    const queue = createMessageQueue(ws);
    await waitForOpen(ws);

    // 先消费 connect.challenge，避免它干扰后续「无响应」断言。
    const challenge = JSON.parse(await queue.next()) as { type?: string; event?: string };
    expect(challenge.type).toBe("event");
    expect(challenge.event).toBe("connect.challenge");

    // 未完成握手时发一个 type:"req" 但 method 不是 connect 的消息（模拟未来协议方法）。
    ws.send(
      JSON.stringify({
        type: "req",
        id: "v4-method-1",
        method: "otherMethod",
        params: { nonce: "whatever" },
      }),
    );

    // 短时间内必须没有任何响应（不是 invalid nonce，也不是 ok）。
    const reply = await queue.next(500).then(
      (raw) => raw,
      () => null,
    );
    expect(reply).toBeNull();

    ws.close();
  });

  // C25 第 1+3 条：旧连接的延迟响应（带旧 nonce）不得污染当前连接的握手状态。
  // 场景：连接 A 收 challenge 后断开，连接 B 建立；从 B 发送带「A 的 nonce」的
  // connect（模拟跨连接串扰），必须被拒绝且 B 不被标记为已握手；B 用正确 nonce
  // 重新握手后连接才成立。
  it("ignores stale connect responses from a previous connection", async () => {
    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    // 连接 A：收到 challenge，保存 nonce，然后断开（模拟 MV3 worker 重启）。
    const extA = new WebSocket(extensionWsUrl(port));
    const queueA = createMessageQueue(extA);
    await waitForOpen(extA);
    const challengeA = JSON.parse(await queueA.next()) as { payload?: { nonce?: string } };
    const staleNonce = challengeA.payload?.nonce ?? "";
    expect(staleNonce).not.toBe("");
    extA.close();
    await waitForClose(extA);

    // 连接 B：收到新 challenge。
    const extB = new WebSocket(extensionWsUrl(port));
    const queueB = createMessageQueue(extB);
    await waitForOpen(extB);
    const challengeB = JSON.parse(await queueB.next()) as { payload?: { nonce?: string } };
    const currentNonce = challengeB.payload?.nonce ?? "";
    expect(currentNonce).not.toBe("");
    expect(currentNonce).not.toBe(staleNonce);

    // 从 B 发送带旧 nonce 的 connect（版本合法 3–3）——必须被拒。
    extB.send(
      JSON.stringify({
        type: "req",
        id: "stale-connect",
        method: "connect",
        params: { minProtocol: 3, maxProtocol: 3, nonce: staleNonce },
      }),
    );
    const staleRes = JSON.parse(await queueB.next()) as {
      ok?: boolean;
      error?: { message?: string };
    };
    expect(staleRes.ok).toBe(false);
    expect(staleRes.error?.message).toBe("invalid nonce");

    // 旧 nonce 响应不得把 B 标记为已握手。
    const statusBefore = (await fetch(`${cdpUrl}/extension/status`).then((r) => r.json())) as {
      connected?: boolean;
    };
    expect(statusBefore.connected).toBe(false);

    // B 用正确 nonce 重新握手——成功。
    extB.send(
      JSON.stringify({
        type: "req",
        id: "good-connect",
        method: "connect",
        params: { minProtocol: 3, maxProtocol: 3, nonce: currentNonce },
      }),
    );
    const goodRes = JSON.parse(await queueB.next()) as { ok?: boolean };
    expect(goodRes.ok).toBe(true);

    const statusAfter = (await fetch(`${cdpUrl}/extension/status`).then((r) => r.json())) as {
      connected?: boolean;
    };
    expect(statusAfter.connected).toBe(true);

    extB.close();
  });

  // C25 第 2 条：握手失败后若扩展不再重连（如被卸载），错误应在一段时间后自动
  // 清除，/extension/status 不再返回陈旧的 error，避免现场被「升级客户端」误导。
  it("clears stale handshake error after disconnect without a new connection", async () => {
    process.env.OPENCLAW_EXTENSION_RELAY_HANDSHAKE_ERROR_TTL_MS = "80";

    const port = await getFreePort();
    cdpUrl = `http://127.0.0.1:${port}`;
    await ensureChromeExtensionRelayServer({ cdpUrl });

    const { ws: ext, result } = await connectExtensionExpectRejection(port, 999, 999);
    expect(result.ok).toBe(false);
    await waitForClose(ext);

    const statusWithError = (await fetch(`${cdpUrl}/extension/status`).then((r) => r.json())) as {
      connected?: boolean;
      error?: string;
    };
    expect(statusWithError.connected).toBe(false);
    expect(statusWithError.error ?? "").toContain("扩展协议版本不匹配");

    // 等 TTL 过期（80ms）后再等一轮探测余量。
    await new Promise((r) => setTimeout(r, 250));
    const statusAfter = (await fetch(`${cdpUrl}/extension/status`).then((r) => r.json())) as {
      connected?: boolean;
      error?: string;
    };
    expect(statusAfter.connected).toBe(false);
    expect(statusAfter.error ?? "").toBe("");
  });

  it("keeps CDP clients alive across a brief extension reconnect", async () => {
    const { port, ext: ext1 } = await startRelayWithExtension();
    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/cdp`),
    });
    await waitForOpen(cdp);

    let cdpClosed = false;
    cdp.once("close", () => {
      cdpClosed = true;
    });

    const ext1Closed = waitForClose(ext1, 2_000);
    ext1.close();
    await ext1Closed;
    const ext2 = await connectExtensionAt(port, true);
    expect(cdpClosed).toBe(false);

    cdp.close();
    ext2.close();
  });

  it("keeps /json/version websocket endpoint during short extension disconnects", async () => {
    const { port, ext } = await startRelayWithExtension();
    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "cb-tab-disconnect",
            targetInfo: {
              targetId: "t-disconnect",
              type: "page",
              title: "Disconnect test",
              url: "https://example.com",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    await waitForListMatch(
      async () =>
        (await fetch(`${cdpUrl}/json/list`, {
          headers: relayAuthHeaders(cdpUrl),
        }).then((r) => r.json())) as Array<{ id?: string }>,
      (list) => list.some((entry) => entry.id === "t-disconnect"),
    );

    const extClosed = waitForClose(ext, 2_000);
    ext.close();
    await extClosed;

    const version = (await fetch(`${cdpUrl}/json/version`, {
      headers: relayAuthHeaders(cdpUrl),
    }).then((r) => r.json())) as {
      webSocketDebuggerUrl?: string;
    };
    expect(String(version.webSocketDebuggerUrl ?? "")).toContain("/cdp");

    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/cdp`),
    });
    await waitForOpen(cdp);
    cdp.close();
  });

  it("accepts re-announce attach events with minimal targetInfo", async () => {
    const { ext } = await startRelayWithExtension();
    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "cb-tab-minimal",
            targetInfo: {
              targetId: "t-minimal",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    await waitForListMatch(
      async () =>
        (await fetch(`${cdpUrl}/json/list`, {
          headers: relayAuthHeaders(cdpUrl),
        }).then((r) => r.json())) as Array<{ id?: string }>,
      (entries) => entries.some((entry) => entry.id === "t-minimal"),
    );
  });

  it("waits briefly for extension reconnect before failing CDP commands", async () => {
    const { port, ext: ext1 } = await startRelayWithExtension();
    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/cdp`),
    });
    await waitForOpen(cdp);
    const cdpQueue = createMessageQueue(cdp);

    const ext1Closed = waitForClose(ext1, 2_000);
    ext1.close();
    await ext1Closed;

    cdp.send(JSON.stringify({ id: 41, method: "Runtime.enable" }));
    await new Promise((r) => setTimeout(r, 30));

    const ext2 = new WebSocket(`ws://127.0.0.1:${port}/extension`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/extension`),
    });
    const ext2Queue = createMessageQueue(ext2);
    await waitForOpen(ext2);
    await performHandshakeWithQueue(ext2, ext2Queue);

    while (true) {
      const msg = JSON.parse(await ext2Queue.next(4_000)) as {
        id?: number;
        method?: string;
      };
      if (msg.method === "ping") {
        ext2.send(JSON.stringify({ method: "pong" }));
        continue;
      }
      if (msg.method === "forwardCDPCommand" && typeof msg.id === "number") {
        ext2.send(JSON.stringify({ id: msg.id, result: { ok: true } }));
        break;
      }
    }

    const response = JSON.parse(await cdpQueue.next(6_000)) as {
      id?: number;
      result?: { ok?: boolean };
      error?: { message?: string };
    };
    expect(response.id).toBe(41);
    expect(response.error).toBeUndefined();
    expect(response.result?.ok).toBe(true);

    cdp.close();
    ext2.close();
  });

  it("closes CDP clients after reconnect grace when extension stays disconnected", async () => {
    process.env.OPENCLAW_EXTENSION_RELAY_RECONNECT_GRACE_MS = "150";

    const { port, ext } = await startRelayWithExtension();
    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/cdp`),
    });
    await waitForOpen(cdp);

    ext.close();
    await waitForClose(cdp, 2_000);
  });

  it("stops advertising websocket endpoint after reconnect grace expires", async () => {
    process.env.OPENCLAW_EXTENSION_RELAY_RECONNECT_GRACE_MS = "120";

    const { ext } = await startRelayWithExtension();
    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "cb-tab-grace-expire",
            targetInfo: {
              targetId: "t-grace-expire",
              type: "page",
              title: "Grace expire",
              url: "https://example.com",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    await waitForListMatch(
      async () =>
        (await fetch(`${cdpUrl}/json/list`, {
          headers: relayAuthHeaders(cdpUrl),
        }).then((r) => r.json())) as Array<{ id?: string }>,
      (list) => list.some((entry) => entry.id === "t-grace-expire"),
    );

    ext.close();
    await expect
      .poll(
        async () => {
          const version = (await fetch(`${cdpUrl}/json/version`, {
            headers: relayAuthHeaders(cdpUrl),
          }).then((r) => r.json())) as { webSocketDebuggerUrl?: string };
          return version.webSocketDebuggerUrl === undefined;
        },
        { timeout: 800, interval: 20 },
      )
      .toBe(true);
  });

  it("accepts extension websocket access with the fixed relay token query param", async () => {
    const sharedUrl = await ensureSharedRelayServer();
    const sharedPort = new URL(sharedUrl).port;

    const token = relayAuthHeaders(`ws://127.0.0.1:${sharedPort}/extension`)[
      "x-openclaw-relay-token"
    ];
    expect(token).toBe(RELAY_AUTH_TOKEN);
    const ext = new WebSocket(
      `ws://127.0.0.1:${sharedPort}/extension?token=${encodeURIComponent(String(token))}`,
    );
    await waitForOpen(ext);
    ext.close();
  });

  it("accepts /json endpoints with relay token query param", async () => {
    const sharedUrl = await ensureSharedRelayServer();

    const token = relayAuthHeaders(sharedUrl)["x-openclaw-relay-token"];
    expect(token).toBe(RELAY_AUTH_TOKEN);
    const versionRes = await fetch(
      `${sharedUrl}/json/version?token=${encodeURIComponent(String(token))}`,
    );
    expect(versionRes.status).toBe(200);
  });

  it("does not accept legacy gateway token for relay auth", async () => {
    const sharedUrl = await ensureSharedRelayServer();
    const sharedPort = new URL(sharedUrl).port;

    const versionRes = await fetch(`${sharedUrl}/json/version`, {
      headers: { "x-openclaw-relay-token": "test-gateway-token" },
    });
    expect(versionRes.status).toBe(401);

    const ext = new WebSocket(
      `ws://127.0.0.1:${sharedPort}/extension?token=${encodeURIComponent("test-gateway-token")}`,
    );
    const err = await waitForError(ext);
    expect(err.message).toContain("401");
  });

  it(
    "tracks attached page targets and exposes them via CDP + /json/list",
    async () => {
      const { port, ext } = await startRelayWithExtension();

      // Simulate a tab attach coming from the extension.
      ext.send(
        JSON.stringify({
          method: "forwardCDPEvent",
          params: {
            method: "Target.attachedToTarget",
            params: {
              sessionId: "cb-tab-1",
              targetInfo: {
                targetId: "t1",
                type: "page",
                title: "Example",
                url: "https://example.com",
              },
              waitingForDebugger: false,
            },
          },
        }),
      );

      const list = (await fetch(`${cdpUrl}/json/list`, {
        headers: relayAuthHeaders(cdpUrl),
      }).then((r) => r.json())) as Array<{
        id?: string;
        url?: string;
        title?: string;
      }>;
      expect(list.some((t) => t.id === "t1" && t.url === "https://example.com")).toBe(true);

      // Simulate navigation updating tab metadata.
      ext.send(
        JSON.stringify({
          method: "forwardCDPEvent",
          params: {
            method: "Target.targetInfoChanged",
            params: {
              targetInfo: {
                targetId: "t1",
                type: "page",
                title: "DER STANDARD",
                url: "https://www.derstandard.at/",
              },
            },
          },
        }),
      );

      await waitForListMatch(
        async () =>
          (await fetch(`${cdpUrl}/json/list`, {
            headers: relayAuthHeaders(cdpUrl),
          }).then((r) => r.json())) as Array<{
            id?: string;
            url?: string;
            title?: string;
          }>,
        (list) =>
          list.some(
            (t) =>
              t.id === "t1" &&
              t.url === "https://www.derstandard.at/" &&
              t.title === "DER STANDARD",
          ),
      );

      const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
        headers: relayAuthHeaders(`ws://127.0.0.1:${port}/cdp`),
      });
      await waitForOpen(cdp);
      const q = createMessageQueue(cdp);

      cdp.send(JSON.stringify({ id: 1, method: "Target.getTargets" }));
      const res1 = JSON.parse(await q.next()) as { id: number; result?: unknown };
      expect(res1.id).toBe(1);
      const targetInfos = (
        res1.result as { targetInfos?: Array<{ targetId?: string }> } | undefined
      )?.targetInfos;
      expect((targetInfos ?? []).some((target) => target.targetId === "t1")).toBe(true);

      cdp.send(
        JSON.stringify({
          id: 2,
          method: "Target.attachToTarget",
          params: { targetId: "t1" },
        }),
      );
      const received: Array<{
        id?: number;
        method?: string;
        result?: unknown;
        params?: unknown;
      }> = [];
      received.push(JSON.parse(await q.next()) as never);
      received.push(JSON.parse(await q.next()) as never);

      const res2 = received.find((m) => m.id === 2);
      expect(res2?.id).toBe(2);
      expect((res2?.result as { sessionId?: string } | undefined)?.sessionId).toBe("cb-tab-1");

      const evt = received.find((m) => m.method === "Target.attachedToTarget");
      expect(evt?.method).toBe("Target.attachedToTarget");
      expect(
        (evt?.params as { targetInfo?: { targetId?: string } } | undefined)?.targetInfo?.targetId,
      ).toBe("t1");

      cdp.close();
      ext.close();
    },
    RELAY_TEST_TIMEOUT_MS,
  );

  it("removes cached targets from /json/list when targetDestroyed arrives", async () => {
    const { ext } = await startRelayWithExtension();

    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "cb-tab-1",
            targetInfo: {
              targetId: "t1",
              type: "page",
              title: "Example",
              url: "https://example.com",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    await waitForListMatch(
      async () =>
        (await fetch(`${cdpUrl}/json/list`, {
          headers: relayAuthHeaders(cdpUrl),
        }).then((r) => r.json())) as Array<{ id?: string }>,
      (list) => list.some((target) => target.id === "t1"),
    );

    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.targetDestroyed",
          params: { targetId: "t1" },
        },
      }),
    );

    await waitForListMatch(
      async () =>
        (await fetch(`${cdpUrl}/json/list`, {
          headers: relayAuthHeaders(cdpUrl),
        }).then((r) => r.json())) as Array<{ id?: string }>,
      (list) => list.every((target) => target.id !== "t1"),
    );
    ext.close();
  });

  it("prunes stale cached targets after target-not-found command errors", async () => {
    const { port, ext } = await startRelayWithExtension();
    const extQueue = createMessageQueue(ext);

    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "cb-tab-1",
            targetInfo: {
              targetId: "t1",
              type: "page",
              title: "Example",
              url: "https://example.com",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    await waitForListMatch(
      async () =>
        (await fetch(`${cdpUrl}/json/list`, {
          headers: relayAuthHeaders(cdpUrl),
        }).then((r) => r.json())) as Array<{ id?: string }>,
      (list) => list.some((target) => target.id === "t1"),
    );

    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/cdp`),
    });
    await waitForOpen(cdp);
    const cdpQueue = createMessageQueue(cdp);

    cdp.send(
      JSON.stringify({
        id: 77,
        method: "Runtime.evaluate",
        sessionId: "cb-tab-1",
        params: { expression: "1+1" },
      }),
    );

    let forwardedId: number | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const msg = JSON.parse(await extQueue.next()) as { method?: string; id?: number };
      if (msg.method === "forwardCDPCommand" && typeof msg.id === "number") {
        forwardedId = msg.id;
        break;
      }
    }
    expect(forwardedId).not.toBeNull();

    ext.send(
      JSON.stringify({
        id: forwardedId,
        error: "No target with given id",
      }),
    );

    let response: { id?: number; error?: { message?: string } } | null = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const msg = JSON.parse(await cdpQueue.next()) as {
        id?: number;
        error?: { message?: string };
      };
      if (msg.id === 77) {
        response = msg;
        break;
      }
    }
    expect(response?.id).toBe(77);
    expect(response?.error?.message ?? "").toContain("No target with given id");

    await waitForListMatch(
      async () =>
        (await fetch(`${cdpUrl}/json/list`, {
          headers: relayAuthHeaders(cdpUrl),
        }).then((r) => r.json())) as Array<{ id?: string }>,
      (list) => list.every((target) => target.id !== "t1"),
    );

    cdp.close();
    ext.close();
  });

  it("rebroadcasts attach when a session id is reused for a new target", async () => {
    const { port, ext } = await startRelayWithExtension();

    const cdp = new WebSocket(`ws://127.0.0.1:${port}/cdp`, {
      headers: relayAuthHeaders(`ws://127.0.0.1:${port}/cdp`),
    });
    await waitForOpen(cdp);
    const q = createMessageQueue(cdp);

    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "shared-session",
            targetInfo: {
              targetId: "t1",
              type: "page",
              title: "First",
              url: "https://example.com",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    const first = JSON.parse(await q.next()) as { method?: string; params?: unknown };
    expect(first.method).toBe("Target.attachedToTarget");
    expect(
      (first.params as { targetInfo?: { targetId?: string } } | undefined)?.targetInfo?.targetId,
    ).toBe("t1");

    ext.send(
      JSON.stringify({
        method: "forwardCDPEvent",
        params: {
          method: "Target.attachedToTarget",
          params: {
            sessionId: "shared-session",
            targetInfo: {
              targetId: "t2",
              type: "page",
              title: "Second",
              url: "https://example.org",
            },
            waitingForDebugger: false,
          },
        },
      }),
    );

    const received: Array<{ method?: string; params?: unknown }> = [];
    received.push(JSON.parse(await q.next()) as never);
    received.push(JSON.parse(await q.next()) as never);

    const detached = received.find((m) => m.method === "Target.detachedFromTarget");
    const attached = received.find((m) => m.method === "Target.attachedToTarget");
    expect((detached?.params as { targetId?: string } | undefined)?.targetId).toBe("t1");
    expect(
      (attached?.params as { targetInfo?: { targetId?: string } } | undefined)?.targetInfo
        ?.targetId,
    ).toBe("t2");

    cdp.close();
    ext.close();
  });

  it("reuses an already-bound relay port when another process owns it", async () => {
    const port = await getFreePort();
    const fakeRelay = createServer((req, res) => {
      if (req.url?.startsWith("/extension/status")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ connected: false }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("OK");
    });
    await new Promise<void>((resolve, reject) => {
      fakeRelay.listen(port, "127.0.0.1", () => resolve());
      fakeRelay.once("error", reject);
    });

    try {
      cdpUrl = `http://127.0.0.1:${port}`;
      const relay = await ensureChromeExtensionRelayServer({ cdpUrl });
      expect(relay.port).toBe(port);
      const status = (await fetch(`${cdpUrl}/extension/status`).then((r) => r.json())) as {
        connected?: boolean;
      };
      expect(status.connected).toBe(false);
    } finally {
      await new Promise<void>((resolve) => fakeRelay.close(() => resolve()));
    }
  });

  it(
    "restores tabs after extension reconnects and re-announces",
    async () => {
      process.env.OPENCLAW_EXTENSION_RELAY_RECONNECT_GRACE_MS = "200";

      const { port, ext: ext1 } = await startRelayWithExtension();

      ext1.send(
        JSON.stringify({
          method: "forwardCDPEvent",
          params: {
            method: "Target.attachedToTarget",
            params: {
              sessionId: "cb-tab-10",
              targetInfo: {
                targetId: "t10",
                type: "page",
                title: "My Page",
                url: "https://example.com",
              },
              waitingForDebugger: false,
            },
          },
        }),
      );

      await waitForListMatch(
        async () =>
          (await fetch(`${cdpUrl}/json/list`, {
            headers: relayAuthHeaders(cdpUrl),
          }).then((r) => r.json())) as Array<{ id?: string }>,
        (list) => list.some((t) => t.id === "t10"),
      );

      // Disconnect extension and wait for grace period cleanup.
      const ext1Closed = waitForClose(ext1, 2_000);
      ext1.close();
      await ext1Closed;
      await waitForListMatch(
        async () =>
          (await fetch(`${cdpUrl}/json/list`, {
            headers: relayAuthHeaders(cdpUrl),
          }).then((r) => r.json())) as Array<{ id?: string }>,
        (list) => list.length === 0,
      );

      // Reconnect and re-announce the same tab (simulates reannounceAttachedTabs).
      const ext2 = await connectExtensionAt(port, true);

      ext2.send(
        JSON.stringify({
          method: "forwardCDPEvent",
          params: {
            method: "Target.attachedToTarget",
            params: {
              sessionId: "cb-tab-10",
              targetInfo: {
                targetId: "t10",
                type: "page",
                title: "My Page",
                url: "https://example.com",
              },
              waitingForDebugger: false,
            },
          },
        }),
      );

      const list2 = await waitForListMatch(
        async () =>
          (await fetch(`${cdpUrl}/json/list`, {
            headers: relayAuthHeaders(cdpUrl),
          }).then((r) => r.json())) as Array<{ id?: string; title?: string }>,
        (list) => list.some((t) => t.id === "t10"),
      );
      expect(list2.some((t) => t.id === "t10" && t.title === "My Page")).toBe(true);

      ext2.close();
    },
    RELAY_TEST_TIMEOUT_MS,
  );

  it(
    "preserves tab across a fast extension reconnect within grace period",
    async () => {
      process.env.OPENCLAW_EXTENSION_RELAY_RECONNECT_GRACE_MS = "2000";

      const { port, ext: ext1 } = await startRelayWithExtension();

      ext1.send(
        JSON.stringify({
          method: "forwardCDPEvent",
          params: {
            method: "Target.attachedToTarget",
            params: {
              sessionId: "cb-tab-20",
              targetInfo: {
                targetId: "t20",
                type: "page",
                title: "Persistent",
                url: "https://example.org",
              },
              waitingForDebugger: false,
            },
          },
        }),
      );

      await waitForListMatch(
        async () =>
          (await fetch(`${cdpUrl}/json/list`, {
            headers: relayAuthHeaders(cdpUrl),
          }).then((r) => r.json())) as Array<{ id?: string }>,
        (list) => list.some((t) => t.id === "t20"),
      );

      // Disconnect briefly (within grace period).
      const ext1Closed = waitForClose(ext1, 2_000);
      ext1.close();
      await ext1Closed;

      // Tab should still be listed during grace period.
      const listDuringGrace = (await fetch(`${cdpUrl}/json/list`, {
        headers: relayAuthHeaders(cdpUrl),
      }).then((r) => r.json())) as Array<{ id?: string }>;
      expect(listDuringGrace.some((t) => t.id === "t20")).toBe(true);

      // Reconnect within grace and re-announce with updated info.
      const ext2 = await connectExtensionAt(port, true);

      ext2.send(
        JSON.stringify({
          method: "forwardCDPEvent",
          params: {
            method: "Target.attachedToTarget",
            params: {
              sessionId: "cb-tab-20",
              targetInfo: {
                targetId: "t20",
                type: "page",
                title: "Persistent Updated",
                url: "https://example.org/new",
              },
              waitingForDebugger: false,
            },
          },
        }),
      );

      const list2 = await waitForListMatch(
        async () =>
          (await fetch(`${cdpUrl}/json/list`, {
            headers: relayAuthHeaders(cdpUrl),
          }).then((r) => r.json())) as Array<{ id?: string; title?: string; url?: string }>,
        (list) => list.some((t) => t.id === "t20" && t.title === "Persistent Updated"),
      );
      expect(list2.some((t) => t.id === "t20" && t.url === "https://example.org/new")).toBe(true);

      ext2.close();
    },
    RELAY_TEST_TIMEOUT_MS,
  );

  it("does not swallow EADDRINUSE when occupied port is not an openclaw relay", async () => {
    const port = await getFreePort();
    const blocker = createServer((_, res) => {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not-relay");
    });
    await new Promise<void>((resolve, reject) => {
      blocker.listen(port, "127.0.0.1", () => resolve());
      blocker.once("error", reject);
    });
    const blockedUrl = `http://127.0.0.1:${port}`;
    await expect(ensureChromeExtensionRelayServer({ cdpUrl: blockedUrl })).rejects.toThrow(
      /EADDRINUSE/i,
    );
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  });

  it(
    "respects bindHost override to bind on a non-loopback address",
    async () => {
      const port = await getFreePort();
      cdpUrl = `http://127.0.0.1:${port}`;
      const relay = await ensureChromeExtensionRelayServer({
        cdpUrl,
        bindHost: "0.0.0.0",
      });
      expect(relay.port).toBe(port);
      // Verify the server actually bound to 0.0.0.0, not the cdpUrl host.
      expect(relay.bindHost).toBe("0.0.0.0");

      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
    },
    RELAY_TEST_TIMEOUT_MS,
  );

  it(
    "defaults bindHost to cdpUrl host when not specified",
    async () => {
      const port = await getFreePort();
      cdpUrl = `http://127.0.0.1:${port}`;
      const relay = await ensureChromeExtensionRelayServer({ cdpUrl });
      expect(relay.host).toBe("127.0.0.1");
      expect(relay.bindHost).toBe("127.0.0.1");

      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
    },
    RELAY_TEST_TIMEOUT_MS,
  );

  it(
    "restarts the relay when bindHost changes for the same port",
    async () => {
      const port = await getFreePort();
      cdpUrl = `http://127.0.0.1:${port}`;

      const initial = await ensureChromeExtensionRelayServer({ cdpUrl });
      expect(initial.bindHost).toBe("127.0.0.1");

      const rebound = await ensureChromeExtensionRelayServer({
        cdpUrl,
        bindHost: "0.0.0.0",
      });
      expect(rebound.bindHost).toBe("0.0.0.0");
      expect(rebound.port).toBe(port);
    },
    RELAY_TEST_TIMEOUT_MS,
  );
});
