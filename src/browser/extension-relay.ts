import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { isLoopbackAddress, isLoopbackHost } from "../gateway/net.js";
import { rawDataToString } from "../infra/ws.js";
import { createRelayAuthToken, probeClawserRelay } from "./extension-relay-auth.js";

function randomNonce(): string {
  return randomBytes(16).toString("hex");
}

type CdpCommand = {
  id: number;
  method: string;
  params?: unknown;
  sessionId?: string;
};

type CdpResponse = {
  id: number;
  result?: unknown;
  error?: { message: string };
  sessionId?: string;
};

type CdpEvent = {
  method: string;
  params?: unknown;
  sessionId?: string;
};

type ExtensionForwardCommandMessage = {
  id: number;
  method: "forwardCDPCommand";
  params: { method: string; params?: unknown; sessionId?: string };
};

type ExtensionResponseMessage = {
  id: number;
  result?: unknown;
  error?: string;
};

type ExtensionForwardEventMessage = {
  method: "forwardCDPEvent";
  params: { method: string; params?: unknown; sessionId?: string };
};

type ExtensionPingMessage = { method: "ping" };
type ExtensionPongMessage = { method: "pong" };

// 扩展 ↔ 中继的应用层协议版本范围（与扩展 background.js 的
// minProtocol / maxProtocol 声明对应）。协议消息格式或方法不兼容时提升版本；
// 上架后 Edge 会自动更新扩展，此处在握手时校验，协议不匹配的连接被显式
// 拒绝并给出原因，而不是静默接受导致「连上了却接管不了页面」。
const RELAY_PROTOCOL_MIN = 3;
const RELAY_PROTOCOL_MAX = 3;
const EXTENSION_HANDSHAKE_TIMEOUT_MS = 10_000;
// 握手失败原因在无连接状态下的保留时长（过期自动清除，避免误导现场排查）。
// 测试可用 OPENCLAW_EXTENSION_RELAY_HANDSHAKE_ERROR_TTL_MS 缩短。
const DEFAULT_HANDSHAKE_ERROR_TTL_MS = 60_000;

// ExtensionConnectRequest 是扩展握手时发送的 connect 请求。
type ExtensionConnectRequest = {
  type: "req";
  id: string;
  method: "connect";
  params?: {
    minProtocol?: number;
    maxProtocol?: number;
    client?: { id?: string; version?: string; platform?: string };
    nonce?: string;
  };
};

type ExtensionMessage =
  | ExtensionResponseMessage
  | ExtensionForwardEventMessage
  | ExtensionPongMessage
  | ExtensionConnectRequest;

type TargetInfo = {
  targetId: string;
  type?: string;
  title?: string;
  url?: string;
  attached?: boolean;
};

type AttachedToTargetEvent = {
  sessionId: string;
  targetInfo: TargetInfo;
  waitingForDebugger?: boolean;
};

type DetachedFromTargetEvent = {
  sessionId: string;
  targetId?: string;
};

type ConnectedTarget = {
  sessionId: string;
  targetId: string;
  targetInfo: TargetInfo;
};

type DownloadBehavior = {
  behavior?: string;
  downloadPath?: string;
  eventsEnabled?: boolean;
};

type DownloadRecord = {
  downloadPath: string;
  suggestedFilename: string;
};

const RELAY_AUTH_HEADER = "x-openclaw-relay-token";
const DEFAULT_EXTENSION_RECONNECT_GRACE_MS = 20_000;
const DEFAULT_EXTENSION_COMMAND_RECONNECT_WAIT_MS = 3_000;

function headerValue(value: string | string[] | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

function getHeader(req: IncomingMessage, name: string): string | undefined {
  return headerValue(req.headers[name.toLowerCase()]);
}

function getRelayAuthTokenFromRequest(req: IncomingMessage, url?: URL): string | undefined {
  const headerToken = getHeader(req, RELAY_AUTH_HEADER)?.trim();
  if (headerToken) {
    return headerToken;
  }
  const queryToken = url?.searchParams.get("token")?.trim();
  if (queryToken) {
    return queryToken;
  }
  return undefined;
}

export type ChromeExtensionRelayServer = {
  host: string;
  bindHost: string;
  port: number;
  baseUrl: string;
  cdpWsUrl: string;
  extensionConnected: () => boolean;
  stop: () => Promise<void>;
};

type RelayRuntime = {
  server: ChromeExtensionRelayServer;
  relayAuthToken: string;
};

function parseUrlPort(parsed: URL): number | null {
  const port =
    parsed.port?.trim() !== "" ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return null;
  }
  return port;
}

function parseBaseUrl(raw: string): {
  host: string;
  port: number;
  baseUrl: string;
} {
  const parsed = new URL(raw.trim().replace(/\/$/, ""));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`extension relay cdpUrl must be http(s), got ${parsed.protocol}`);
  }
  const host = parsed.hostname;
  const port = parseUrlPort(parsed);
  if (!port) {
    throw new Error(`extension relay cdpUrl has invalid port: ${parsed.port || "(empty)"}`);
  }
  return { host, port, baseUrl: parsed.toString().replace(/\/$/, "") };
}

function text(res: Duplex, status: number, bodyText: string) {
  const body = Buffer.from(bodyText);
  res.write(
    `HTTP/1.1 ${status} ${status === 200 ? "OK" : "ERR"}\r\n` +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${body.length}\r\n` +
      "Connection: close\r\n" +
      "\r\n",
  );
  res.write(body);
  res.end();
}

function rejectUpgrade(socket: Duplex, status: number, bodyText: string) {
  text(socket, status, bodyText);
  try {
    socket.destroy();
  } catch {
    // ignore
  }
}

function envMsOrDefault(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function toPageDownloadBehavior(params: DownloadBehavior): DownloadBehavior {
  return {
    behavior: params.behavior,
    downloadPath: params.downloadPath,
    eventsEnabled: params.eventsEnabled,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function suggestedFilenamePattern(fileName: string): RegExp {
  const ext = path.extname(fileName);
  const base = ext ? fileName.slice(0, -ext.length) : fileName;
  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escapeRegex(base)}(?: \\\\(\\d+\\\\))?${escapeRegex(ext)}$`);
}

const relayRuntimeByPort = new Map<number, RelayRuntime>();
const relayInitByPort = new Map<number, Promise<ChromeExtensionRelayServer>>();

function isAddrInUseError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "EADDRINUSE"
  );
}

function relayAuthTokenForUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!isLoopbackHost(parsed.hostname)) {
      return null;
    }
    const port = parseUrlPort(parsed);
    if (!port) {
      return null;
    }
    return relayRuntimeByPort.get(port)?.relayAuthToken ?? null;
  } catch {
    return null;
  }
}

export function getChromeExtensionRelayAuthHeaders(url: string): Record<string, string> {
  const token = relayAuthTokenForUrl(url);
  if (!token) {
    return {};
  }
  return { [RELAY_AUTH_HEADER]: token };
}

export async function ensureChromeExtensionRelayServer(opts: {
  cdpUrl: string;
  bindHost?: string;
}): Promise<ChromeExtensionRelayServer> {
  const info = parseBaseUrl(opts.cdpUrl);
  if (!isLoopbackHost(info.host)) {
    throw new Error(`extension relay requires loopback cdpUrl host (got ${info.host})`);
  }
  const bindHost = opts.bindHost ?? info.host;

  const existing = relayRuntimeByPort.get(info.port);
  if (existing) {
    if (existing.server.bindHost !== bindHost) {
      await existing.server.stop();
    } else {
      return existing.server;
    }
  }

  const inFlight = relayInitByPort.get(info.port);
  if (inFlight) {
    const server = await inFlight;
    if (server.bindHost === bindHost) {
      return server;
    }
    await server.stop();
  }

  const extensionReconnectGraceMs = envMsOrDefault(
    "OPENCLAW_EXTENSION_RELAY_RECONNECT_GRACE_MS",
    DEFAULT_EXTENSION_RECONNECT_GRACE_MS,
  );
  const extensionCommandReconnectWaitMs = envMsOrDefault(
    "OPENCLAW_EXTENSION_RELAY_COMMAND_RECONNECT_WAIT_MS",
    DEFAULT_EXTENSION_COMMAND_RECONNECT_WAIT_MS,
  );
  const handshakeErrorTtlMs = envMsOrDefault(
    "OPENCLAW_EXTENSION_RELAY_HANDSHAKE_ERROR_TTL_MS",
    DEFAULT_HANDSHAKE_ERROR_TTL_MS,
  );

  const initPromise = (async (): Promise<ChromeExtensionRelayServer> => {
    const relayAuthToken = createRelayAuthToken();
    const relayAuthTokens = new Set([relayAuthToken]);

    let extensionWs: WebSocket | null = null;
    const cdpClients = new Set<WebSocket>();
    const connectedTargets = new Map<string, ConnectedTarget>();
    let downloadBehavior: DownloadBehavior | null = null;
    const downloadsByGuid = new Map<string, DownloadRecord>();
    // 握手状态：连接建立后 relay 发 connect.challenge（携带 nonce），扩展回 connect
    // 请求（回传 nonce 并声明协议版本范围），校验通过后连接才被视为已建立。
    let extensionHandshakeDone = false;
    let extensionHandshakeError: string | null = null;
    let extensionHandshakeErrorTimer: NodeJS.Timeout | null = null;
    let extensionHandshakeNonce: string | null = null;
    let extensionHandshakeTimer: NodeJS.Timeout | null = null;
    // socket 层：WS 是否 OPEN（单连接限制、传输层判断用）。
    const extensionSocketActive = () => extensionWs?.readyState === WebSocket.OPEN;
    // 应用层：WS OPEN 且协议握手已通过（对外状态、能力判断用）。
    const extensionConnected = () => extensionSocketActive() && extensionHandshakeDone;
    const hasConnectedTargets = () => connectedTargets.size > 0;
    let extensionDisconnectCleanupTimer: NodeJS.Timeout | null = null;
    const extensionReconnectWaiters = new Set<(connected: boolean) => void>();

    const flushExtensionReconnectWaiters = (connected: boolean) => {
      if (extensionReconnectWaiters.size === 0) {
        return;
      }
      const waiters = Array.from(extensionReconnectWaiters);
      extensionReconnectWaiters.clear();
      for (const waiter of waiters) {
        waiter(connected);
      }
    };

    const clearExtensionDisconnectCleanupTimer = () => {
      if (!extensionDisconnectCleanupTimer) {
        return;
      }
      clearTimeout(extensionDisconnectCleanupTimer);
      extensionDisconnectCleanupTimer = null;
    };

    const closeCdpClientsAfterExtensionDisconnect = () => {
      connectedTargets.clear();
      for (const client of cdpClients) {
        try {
          client.close(1011, "extension disconnected");
        } catch {
          // ignore
        }
      }
      cdpClients.clear();
      flushExtensionReconnectWaiters(false);
    };

    const scheduleExtensionDisconnectCleanup = () => {
      clearExtensionDisconnectCleanupTimer();
      extensionDisconnectCleanupTimer = setTimeout(() => {
        extensionDisconnectCleanupTimer = null;
        if (extensionConnected()) {
          return;
        }
        closeCdpClientsAfterExtensionDisconnect();
      }, extensionReconnectGraceMs);
    };

    const waitForExtensionReconnect = async (timeoutMs: number): Promise<boolean> => {
      if (extensionConnected()) {
        return true;
      }
      return await new Promise<boolean>((resolve) => {
        let settled = false;
        const waiter = (connected: boolean) => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          extensionReconnectWaiters.delete(waiter);
          resolve(connected);
        };
        const timer = setTimeout(() => {
          waiter(false);
        }, timeoutMs);
        extensionReconnectWaiters.add(waiter);
      });
    };

    const pendingExtension = new Map<
      number,
      {
        resolve: (v: unknown) => void;
        reject: (e: Error) => void;
        timer: NodeJS.Timeout;
      }
    >();
    let nextExtensionId = 1;

    const sendToExtension = async (payload: ExtensionForwardCommandMessage): Promise<unknown> => {
      const ws = extensionWs;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("Chrome extension not connected");
      }
      ws.send(JSON.stringify(payload));
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingExtension.delete(payload.id);
          reject(new Error(`extension request timeout: ${payload.params.method}`));
        }, 30_000);
        pendingExtension.set(payload.id, { resolve, reject, timer });
      });
    };

    // 记录握手失败原因，并在一段无连接时间后自动清除（陈旧 error 不永久误导现场：
    // 若用户握手失败后卸载了扩展，托盘不应一直提示「升级客户端」）。
    // 不采用「断开即清」：握手失败会被 relay 以 1008 主动关闭，断开即清会让
    // 托盘几乎永远看不到原因（重连循环中 socket 活动窗口只有毫秒级），C24 的
    // 「显示可行动原因」目标就落空了。保留 + 短 TTL 同时满足两者。
    const setHandshakeError = (detail: string) => {
      extensionHandshakeError = detail;
      if (extensionHandshakeErrorTimer) {
        clearTimeout(extensionHandshakeErrorTimer);
      }
      extensionHandshakeErrorTimer = setTimeout(() => {
        extensionHandshakeError = null;
        extensionHandshakeErrorTimer = null;
      }, handshakeErrorTtlMs);
    };

    // 处理扩展握手时的 connect 请求：比对协议版本范围，不匹配则拒绝并给出可行动原因。
    const handleExtensionConnect = (req: ExtensionConnectRequest, ws: WebSocket) => {
      // 1) 连接身份检查：只处理当前连接的响应。MV3 worker 频繁重启时，旧连接的
      //    connect 响应可能延迟到达，直接修改模块级握手状态会让新连接的校验形同虚设。
      if (extensionWs !== ws) {
        return;
      }
      const params = req.params ?? {};
      // 2) nonce 校验：challenge 带出的随机数必须原样回传。安全上冗余（连接已过
      //    回环/Origin/令牌三道认证），但能兜住跨连接串扰——旧连接的响应带旧 nonce。
      if (params.nonce !== extensionHandshakeNonce) {
        try {
          ws.send(
            JSON.stringify({
              type: "res",
              id: req.id,
              ok: false,
              error: { message: "invalid nonce" },
            }),
          );
        } catch {
          // ignore
        }
        return;
      }
      const minP = typeof params.minProtocol === "number" ? params.minProtocol : Number.NaN;
      const maxP = typeof params.maxProtocol === "number" ? params.maxProtocol : Number.NaN;
      const declared = Number.isFinite(minP) && Number.isFinite(maxP) ? `${minP}–${maxP}` : "未知";
      const compatible =
        Number.isFinite(minP) &&
        Number.isFinite(maxP) &&
        maxP >= RELAY_PROTOCOL_MIN &&
        minP <= RELAY_PROTOCOL_MAX;

      if (compatible) {
        extensionHandshakeDone = true;
        if (extensionHandshakeTimer) {
          clearTimeout(extensionHandshakeTimer);
          extensionHandshakeTimer = null;
        }
        flushExtensionReconnectWaiters(true);
        ws.send(
          JSON.stringify({
            type: "res",
            id: req.id,
            ok: true,
          }),
        );
        return;
      }

      const detail = `扩展协议版本不匹配（扩展 ${declared}，客户端支持 ${RELAY_PROTOCOL_MIN}–${RELAY_PROTOCOL_MAX}），请升级 Clawser 客户端`;
      setHandshakeError(detail);
      try {
        ws.send(
          JSON.stringify({
            type: "res",
            id: req.id,
            ok: false,
            error: { message: detail },
          }),
        );
      } catch {
        // ignore
      }
      try {
        ws.close(1008, "protocol mismatch");
      } catch {
        // ignore
      }
      closeCdpClientsAfterExtensionDisconnect();
    };

    const broadcastToCdpClients = (evt: CdpEvent) => {
      const msg = JSON.stringify(evt);
      for (const ws of cdpClients) {
        if (ws.readyState !== WebSocket.OPEN) {
          continue;
        }
        ws.send(msg);
      }
    };

    const sendResponseToCdp = (ws: WebSocket, res: CdpResponse) => {
      if (ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(JSON.stringify(res));
    };

    const dropConnectedTargetSession = (sessionId: string): ConnectedTarget | undefined => {
      const existing = connectedTargets.get(sessionId);
      if (!existing) {
        return undefined;
      }
      connectedTargets.delete(sessionId);
      return existing;
    };

    const dropConnectedTargetsByTargetId = (targetId: string): ConnectedTarget[] => {
      const removed: ConnectedTarget[] = [];
      for (const [sessionId, target] of connectedTargets) {
        if (target.targetId !== targetId) {
          continue;
        }
        connectedTargets.delete(sessionId);
        removed.push(target);
      }
      return removed;
    };

    const broadcastDetachedTarget = (target: ConnectedTarget, targetId?: string) => {
      broadcastToCdpClients({
        method: "Target.detachedFromTarget",
        params: {
          sessionId: target.sessionId,
          targetId: targetId ?? target.targetId,
        },
        sessionId: target.sessionId,
      });
    };

    const isMissingTargetError = (err: unknown) => {
      const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
      return (
        message.includes("target not found") ||
        message.includes("no target with given id") ||
        message.includes("session not found") ||
        message.includes("cannot find session")
      );
    };

    const pruneStaleTargetsFromCommandFailure = (cmd: CdpCommand, err: unknown) => {
      if (!isMissingTargetError(err)) {
        return;
      }
      if (cmd.sessionId) {
        const removed = dropConnectedTargetSession(cmd.sessionId);
        if (removed) {
          broadcastDetachedTarget(removed);
          return;
        }
      }
      const params = (cmd.params ?? {}) as { targetId?: unknown };
      const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
      if (!targetId) {
        return;
      }
      const removedTargets = dropConnectedTargetsByTargetId(targetId);
      for (const removed of removedTargets) {
        broadcastDetachedTarget(removed, targetId);
      }
    };

    const ensureTargetEventsForClient = (ws: WebSocket, mode: "autoAttach" | "discover") => {
      for (const target of connectedTargets.values()) {
        if (mode === "autoAttach") {
          ws.send(
            JSON.stringify({
              method: "Target.attachedToTarget",
              params: {
                sessionId: target.sessionId,
                targetInfo: { ...target.targetInfo, attached: true },
                waitingForDebugger: false,
              },
            } satisfies CdpEvent),
          );
        } else {
          ws.send(
            JSON.stringify({
              method: "Target.targetCreated",
              params: { targetInfo: { ...target.targetInfo, attached: true } },
            } satisfies CdpEvent),
          );
        }
      }
    };

    const routeCdpCommand = async (cmd: CdpCommand): Promise<unknown> => {
      const applyDownloadBehaviorToTarget = async (target: ConnectedTarget): Promise<void> => {
        if (!downloadBehavior) {
          return;
        }
        await sendToExtension({
          id: nextExtensionId++,
          method: "forwardCDPCommand",
          params: {
            method: "Page.setDownloadBehavior",
            sessionId: target.sessionId,
            params: downloadBehavior,
          },
        }).catch(() => {});
      };

      switch (cmd.method) {
        case "Browser.getVersion":
          return {
            protocolVersion: "1.3",
            product: "Chrome/Clawser-Extension-Relay",
            revision: "0",
            userAgent: "Clawser-Extension-Relay",
            jsVersion: "V8",
          };
        case "Browser.setDownloadBehavior": {
          const params = (cmd.params ?? {}) as DownloadBehavior;
          downloadBehavior = toPageDownloadBehavior(params);
          await Promise.all(
            Array.from(connectedTargets.values()).map((target) =>
              applyDownloadBehaviorToTarget(target),
            ),
          );
          return {};
        }
        case "Target.setAutoAttach":
        case "Target.setDiscoverTargets":
          return {};
        case "Target.getTargets":
          return {
            targetInfos: Array.from(connectedTargets.values()).map((t) => ({
              ...t.targetInfo,
              attached: true,
            })),
          };
        case "Target.getTargetInfo": {
          const params = (cmd.params ?? {}) as { targetId?: string };
          const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
          if (targetId) {
            for (const t of connectedTargets.values()) {
              if (t.targetId === targetId) {
                return { targetInfo: t.targetInfo };
              }
            }
          }
          if (cmd.sessionId && connectedTargets.has(cmd.sessionId)) {
            const t = connectedTargets.get(cmd.sessionId);
            if (t) {
              return { targetInfo: t.targetInfo };
            }
          }
          const first = Array.from(connectedTargets.values())[0];
          return { targetInfo: first?.targetInfo };
        }
        case "Target.attachToTarget": {
          const params = (cmd.params ?? {}) as { targetId?: string };
          const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
          if (!targetId) {
            throw new Error("targetId required");
          }
          for (const t of connectedTargets.values()) {
            if (t.targetId === targetId) {
              return { sessionId: t.sessionId };
            }
          }
          throw new Error("target not found");
        }
        default: {
          const id = nextExtensionId++;
          return await sendToExtension({
            id,
            method: "forwardCDPCommand",
            params: {
              method: cmd.method,
              sessionId: cmd.sessionId,
              params: cmd.params,
            },
          });
        }
      }
    };

    const rememberDownloadWillBegin = (params: unknown) => {
      if (!isRecord(params) || !downloadBehavior?.downloadPath) {
        console.warn(
          "[browser/extension-relay] download start missing behavior downloadPath",
          JSON.stringify({ params, downloadBehavior }),
        );
        return;
      }
      const guid = typeof params.guid === "string" ? params.guid.trim() : "";
      const suggestedFilename =
        typeof params.suggestedFilename === "string" ? params.suggestedFilename.trim() : "";
      if (!guid || !suggestedFilename) {
        console.warn(
          "[browser/extension-relay] download start missing guid/suggested filename",
          JSON.stringify(params),
        );
        return;
      }
      downloadsByGuid.set(guid, {
        downloadPath: downloadBehavior.downloadPath,
        suggestedFilename: path.basename(suggestedFilename),
      });
    };

    const findDefaultDownloadFile = async (rec: DownloadRecord): Promise<string | null> => {
      const downloadsDir = path.join(os.homedir(), "Downloads");
      const pattern = suggestedFilenamePattern(rec.suggestedFilename);
      const entries = await fs.readdir(downloadsDir).catch(() => []);
      let best: { path: string; mtimeMs: number } | null = null;
      for (const entry of entries) {
        if (!pattern.test(entry)) {
          continue;
        }
        const candidate = path.join(downloadsDir, entry);
        const stat = await fs.stat(candidate).catch(() => null);
        if (!stat?.isFile()) {
          continue;
        }
        if (!best || stat.mtimeMs > best.mtimeMs) {
          best = { path: candidate, mtimeMs: stat.mtimeMs };
        }
      }
      return best?.path ?? null;
    };

    const materializeDownloadArtifact = async (params: unknown) => {
      if (!isRecord(params) || params.state !== "completed") {
        return;
      }
      const guid = typeof params.guid === "string" ? params.guid.trim() : "";
      if (!guid) {
        return;
      }
      const rec = downloadsByGuid.get(guid);
      downloadsByGuid.delete(guid);
      if (!rec) {
        console.warn(
          "[browser/extension-relay] download completed without start record",
          JSON.stringify(params),
        );
        return;
      }
      const expectedPath = path.join(rec.downloadPath, guid);
      if (await fileExists(expectedPath)) {
        return;
      }
      const sourcePath = path.join(rec.downloadPath, rec.suggestedFilename);
      if (sourcePath === expectedPath) {
        return;
      }
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (await fileExists(sourcePath)) {
          await fs.copyFile(sourcePath, expectedPath).catch(() => {});
          return;
        }
        const defaultDownload = await findDefaultDownloadFile(rec);
        if (defaultDownload) {
          await fs.copyFile(defaultDownload, expectedPath).catch(() => {});
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      console.warn(
        "[browser/extension-relay] download artifact source not found",
        JSON.stringify({ expectedPath, sourcePath, suggestedFilename: rec.suggestedFilename }),
      );
    };

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", info.baseUrl);
      const path = url.pathname;
      const origin = getHeader(req, "origin");
      const isChromeExtensionOrigin =
        typeof origin === "string" && origin.startsWith("chrome-extension://");

      if (isChromeExtensionOrigin && origin) {
        // Let extension pages call relay HTTP endpoints cross-origin.
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
      }

      // Handle CORS preflight requests from the browser extension.
      if (req.method === "OPTIONS") {
        if (origin && !isChromeExtensionOrigin) {
          res.writeHead(403);
          res.end("Forbidden");
          return;
        }
        const requestedHeaders = (getHeader(req, "access-control-request-headers") ?? "")
          .split(",")
          .map((header) => header.trim().toLowerCase())
          .filter((header) => header.length > 0);
        const allowedHeaders = new Set(["content-type", RELAY_AUTH_HEADER, ...requestedHeaders]);
        res.writeHead(204, {
          "Access-Control-Allow-Origin": origin ?? "*",
          "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
          "Access-Control-Allow-Headers": Array.from(allowedHeaders).join(", "),
          "Access-Control-Max-Age": "86400",
          Vary: "Origin, Access-Control-Request-Headers",
        });
        res.end();
        return;
      }

      if (path.startsWith("/json")) {
        const token = getRelayAuthTokenFromRequest(req, url);
        if (!token || !relayAuthTokens.has(token)) {
          res.writeHead(401);
          res.end("Unauthorized");
          return;
        }
      }

      if (req.method === "HEAD" && path === "/") {
        res.writeHead(200);
        res.end();
        return;
      }

      if (path === "/") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("OK");
        return;
      }

      if (path === "/extension/status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            connected: extensionConnected(),
            ...(extensionHandshakeError ? { error: extensionHandshakeError } : {}),
          }),
        );
        return;
      }

      const hostHeader = req.headers.host?.trim() || `${info.host}:${info.port}`;
      const wsHost = `ws://${hostHeader}`;
      const cdpWsUrl = `${wsHost}/cdp`;

      if (
        (path === "/json/version" || path === "/json/version/") &&
        (req.method === "GET" || req.method === "PUT")
      ) {
        const payload: Record<string, unknown> = {
          Browser: "Clawser/extension-relay",
          "Protocol-Version": "1.3",
        };
        // Keep reporting CDP WS while attached targets are cached, so callers can
        // reconnect through brief MV3 worker disconnects.
        if (extensionConnected() || hasConnectedTargets()) {
          payload.webSocketDebuggerUrl = cdpWsUrl;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
        return;
      }

      const listPaths = new Set(["/json", "/json/", "/json/list", "/json/list/"]);
      if (listPaths.has(path) && (req.method === "GET" || req.method === "PUT")) {
        const list = Array.from(connectedTargets.values()).map((t) => ({
          id: t.targetId,
          type: t.targetInfo.type ?? "page",
          title: t.targetInfo.title ?? "",
          description: t.targetInfo.title ?? "",
          url: t.targetInfo.url ?? "",
          webSocketDebuggerUrl: cdpWsUrl,
          devtoolsFrontendUrl: `/devtools/inspector.html?ws=${cdpWsUrl.replace("ws://", "")}`,
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(list));
        return;
      }

      const handleTargetActionRoute = (
        match: RegExpMatchArray | null,
        cdpMethod: "Target.activateTarget" | "Target.closeTarget",
      ): boolean => {
        if (!match || (req.method !== "GET" && req.method !== "PUT")) {
          return false;
        }
        let targetId = "";
        try {
          targetId = decodeURIComponent(match[1] ?? "").trim();
        } catch {
          res.writeHead(400);
          res.end("invalid targetId encoding");
          return true;
        }
        if (!targetId) {
          res.writeHead(400);
          res.end("targetId required");
          return true;
        }
        void (async () => {
          try {
            await sendToExtension({
              id: nextExtensionId++,
              method: "forwardCDPCommand",
              params: { method: cdpMethod, params: { targetId } },
            });
          } catch {
            // ignore
          }
        })();
        res.writeHead(200);
        res.end("OK");
        return true;
      };

      if (
        handleTargetActionRoute(path.match(/^\/json\/activate\/(.+)$/), "Target.activateTarget")
      ) {
        return;
      }
      if (handleTargetActionRoute(path.match(/^\/json\/close\/(.+)$/), "Target.closeTarget")) {
        return;
      }

      res.writeHead(404);
      res.end("not found");
    });

    const wssExtension = new WebSocketServer({ noServer: true });
    const wssCdp = new WebSocketServer({ noServer: true });

    server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", info.baseUrl);
      const pathname = url.pathname;
      const remote = req.socket.remoteAddress;

      // When bindHost is explicitly non-loopback (e.g. 0.0.0.0 for WSL2),
      // allow non-loopback connections; otherwise enforce loopback-only.
      if (!isLoopbackAddress(remote) && isLoopbackHost(bindHost)) {
        rejectUpgrade(socket, 403, "Forbidden");
        return;
      }

      const origin = headerValue(req.headers.origin);
      if (origin && !origin.startsWith("chrome-extension://")) {
        rejectUpgrade(socket, 403, "Forbidden: invalid origin");
        return;
      }

      if (pathname === "/extension") {
        const token = getRelayAuthTokenFromRequest(req, url);
        if (!token || !relayAuthTokens.has(token)) {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }
        // MV3 worker reconnect races can leave a stale non-OPEN socket reference.
        if (extensionWs && extensionWs.readyState !== WebSocket.OPEN) {
          try {
            extensionWs.terminate();
          } catch {
            // ignore
          }
          extensionWs = null;
        }
        if (extensionSocketActive()) {
          rejectUpgrade(socket, 409, "Extension already connected");
          return;
        }
        wssExtension.handleUpgrade(req, socket, head, (ws) => {
          wssExtension.emit("connection", ws, req);
        });
        return;
      }

      if (pathname === "/cdp") {
        const token = getRelayAuthTokenFromRequest(req, url);
        if (!token || !relayAuthTokens.has(token)) {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }
        // Allow CDP clients to connect even during brief extension worker drops.
        // Individual commands already wait briefly for extension reconnect.
        wssCdp.handleUpgrade(req, socket, head, (ws) => {
          wssCdp.emit("connection", ws, req);
        });
        return;
      }

      rejectUpgrade(socket, 404, "Not Found");
    });

    wssExtension.on("connection", (ws) => {
      extensionWs = ws;
      clearExtensionDisconnectCleanupTimer();
      // 注意：不在这里 flush 重连等待者——连接建立后还要过协议握手，
      // 握手成功（handleExtensionConnect）时才视为扩展真正就绪并 flush(true)。

      // 协议握手：发 challenge（携带 nonce），扩展以 connect 请求回复协议版本；匹配才放行。
      extensionHandshakeDone = false;
      extensionHandshakeError = null;
      if (extensionHandshakeErrorTimer) {
        clearTimeout(extensionHandshakeErrorTimer);
        extensionHandshakeErrorTimer = null;
      }
      if (extensionHandshakeTimer) {
        clearTimeout(extensionHandshakeTimer);
        extensionHandshakeTimer = null;
      }
      const nonce = randomNonce();
      extensionHandshakeNonce = nonce;
      try {
        ws.send(
          JSON.stringify({
            type: "event",
            event: "connect.challenge",
            payload: { nonce },
          }),
        );
      } catch {
        // ignore; the message handler below will surface any failure
      }
      extensionHandshakeTimer = setTimeout(() => {
        if (extensionHandshakeDone || extensionWs !== ws) {
          return;
        }
        setHandshakeError("扩展未完成协议握手（扩展版本可能过旧），请升级 Clawser 客户端");
        try {
          ws.close(1008, "extension handshake timeout");
        } catch {
          // ignore
        }
        closeCdpClientsAfterExtensionDisconnect();
      }, EXTENSION_HANDSHAKE_TIMEOUT_MS);

      const ping = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          return;
        }
        ws.send(JSON.stringify({ method: "ping" } satisfies ExtensionPingMessage));
      }, 5000);

      ws.on("message", (data) => {
        if (extensionWs !== ws) {
          return;
        }
        let parsed: ExtensionMessage | null = null;
        try {
          parsed = JSON.parse(rawDataToString(data)) as ExtensionMessage;
        } catch {
          return;
        }

        if (
          parsed &&
          typeof parsed === "object" &&
          "id" in parsed &&
          typeof parsed.id === "number"
        ) {
          const pending = pendingExtension.get(parsed.id);
          if (!pending) {
            return;
          }
          pendingExtension.delete(parsed.id);
          clearTimeout(pending.timer);
          if ("error" in parsed && typeof parsed.error === "string" && parsed.error.trim()) {
            pending.reject(new Error(parsed.error));
          } else {
            // tsgo/tsc 都不会用 typeof 属性收窄非字面量类型（id: number vs string），
            // 所以这里在取值处用 in 收窄：错误回执 { id, error } 没有 result 字段，
            // 不能把 "result" in parsed 放进外层守卫，否则错误回执会被静默丢弃、
            // 请求要卡满 30s 超时才报 "extension request timeout"，真实原因丢失。
            pending.resolve("result" in parsed ? parsed.result : undefined);
          }
          return;
        }

        // 协议握手：扩展回复 connect 请求，校验声明版本与 relay 支持范围是否有交集。
        // method 判断不能省：消息来自独立发版、Edge 自动更新的扩展，类型描述的是期望
        // 而非现实。协议升级出现第二个 type:"req" 方法时，老 relay 若只看 type 会把
        // 新方法当握手请求处理、回 "invalid nonce"，把「版本不匹配」的诊断带偏成认证问题。
        if (
          parsed &&
          typeof parsed === "object" &&
          "type" in parsed &&
          parsed.type === "req" &&
          parsed.method === "connect"
        ) {
          handleExtensionConnect(parsed, ws);
          return;
        }

        // 握手完成前不接受业务消息。这是健壮性处理而非安全边界：未授权连接在
        // WS 升级层已被 401 拒绝，这里防止的是协议不匹配/未完成握手的扩展发出
        // 无法正确处理的消息。
        if (!extensionHandshakeDone) {
          return;
        }

        if (parsed && typeof parsed === "object" && "method" in parsed) {
          if ((parsed as ExtensionPongMessage).method === "pong") {
            return;
          }
          if ((parsed as ExtensionForwardEventMessage).method !== "forwardCDPEvent") {
            return;
          }
          const evt = parsed as ExtensionForwardEventMessage;
          const method = evt.params?.method;
          const params = evt.params?.params;
          const sessionId = evt.params?.sessionId;
          if (!method || typeof method !== "string") {
            return;
          }

          if (method === "Target.attachedToTarget") {
            const attached = (params ?? {}) as AttachedToTargetEvent;
            const targetType = attached?.targetInfo?.type ?? "page";
            if (targetType !== "page") {
              return;
            }
            if (attached?.sessionId && attached?.targetInfo?.targetId) {
              const prev = connectedTargets.get(attached.sessionId);
              const nextTargetId = attached.targetInfo.targetId;
              const prevTargetId = prev?.targetId;
              const changedTarget = Boolean(prev && prevTargetId && prevTargetId !== nextTargetId);
              connectedTargets.set(attached.sessionId, {
                sessionId: attached.sessionId,
                targetId: nextTargetId,
                targetInfo: attached.targetInfo,
              });
              if (downloadBehavior) {
                void sendToExtension({
                  id: nextExtensionId++,
                  method: "forwardCDPCommand",
                  params: {
                    method: "Page.setDownloadBehavior",
                    sessionId: attached.sessionId,
                    params: downloadBehavior,
                  },
                }).catch(() => {});
              }
              if (changedTarget && prevTargetId) {
                broadcastToCdpClients({
                  method: "Target.detachedFromTarget",
                  params: { sessionId: attached.sessionId, targetId: prevTargetId },
                  sessionId: attached.sessionId,
                });
              }
              if (!prev || changedTarget) {
                broadcastToCdpClients({ method, params, sessionId });
              }
              return;
            }
          }

          if (
            downloadBehavior?.eventsEnabled &&
            (method === "Page.downloadWillBegin" ||
              method === "Page.downloadProgress" ||
              method === "Browser.downloadWillBegin" ||
              method === "Browser.downloadProgress")
          ) {
            if (method === "Page.downloadWillBegin" || method === "Browser.downloadWillBegin") {
              rememberDownloadWillBegin(params);
              broadcastToCdpClients({
                method: "Browser.downloadWillBegin",
                params,
              });
            } else {
              void (async () => {
                await materializeDownloadArtifact(params);
                broadcastToCdpClients({
                  method: "Browser.downloadProgress",
                  params,
                });
              })();
            }
            return;
          }

          if (method === "Target.detachedFromTarget") {
            const detached = (params ?? {}) as DetachedFromTargetEvent;
            if (detached?.sessionId) {
              dropConnectedTargetSession(detached.sessionId);
            } else if (detached?.targetId) {
              dropConnectedTargetsByTargetId(detached.targetId);
            }
            broadcastToCdpClients({ method, params, sessionId });
            return;
          }

          if (method === "Target.targetDestroyed" || method === "Target.targetCrashed") {
            const targetEvent = (params ?? {}) as { targetId?: string };
            if (targetEvent.targetId) {
              dropConnectedTargetsByTargetId(targetEvent.targetId);
            }
            broadcastToCdpClients({ method, params, sessionId });
            return;
          }

          // Keep cached tab metadata fresh for /json/list.
          // After navigation, Chrome updates URL/title via Target.targetInfoChanged.
          if (method === "Target.targetInfoChanged") {
            const changed = (params ?? {}) as { targetInfo?: { targetId?: string; type?: string } };
            const targetInfo = changed?.targetInfo;
            const targetId = targetInfo?.targetId;
            if (targetId && (targetInfo?.type ?? "page") === "page") {
              for (const [sid, target] of connectedTargets) {
                if (target.targetId !== targetId) {
                  continue;
                }
                connectedTargets.set(sid, {
                  ...target,
                  targetInfo: { ...target.targetInfo, ...(targetInfo as object) },
                });
              }
            }
          }

          broadcastToCdpClients({ method, params, sessionId });
        }
      });

      ws.on("close", () => {
        clearInterval(ping);
        if (extensionHandshakeTimer) {
          clearTimeout(extensionHandshakeTimer);
          extensionHandshakeTimer = null;
        }
        if (extensionWs !== ws) {
          return;
        }
        extensionWs = null;
        for (const [, pending] of pendingExtension) {
          clearTimeout(pending.timer);
          pending.reject(new Error("extension disconnected"));
        }
        pendingExtension.clear();
        scheduleExtensionDisconnectCleanup();
      });
    });

    wssCdp.on("connection", (ws) => {
      cdpClients.add(ws);

      ws.on("message", async (data) => {
        let cmd: CdpCommand | null = null;
        try {
          cmd = JSON.parse(rawDataToString(data)) as CdpCommand;
        } catch {
          return;
        }
        if (!cmd || typeof cmd !== "object") {
          return;
        }
        if (typeof cmd.id !== "number" || typeof cmd.method !== "string") {
          return;
        }

        if (!extensionConnected()) {
          const reconnected = await waitForExtensionReconnect(extensionCommandReconnectWaitMs);
          if (!reconnected || !extensionConnected()) {
            sendResponseToCdp(ws, {
              id: cmd.id,
              sessionId: cmd.sessionId,
              error: { message: "Extension not connected" },
            });
            return;
          }
        }

        try {
          const result = await routeCdpCommand(cmd);

          if (cmd.method === "Target.setAutoAttach" && !cmd.sessionId) {
            ensureTargetEventsForClient(ws, "autoAttach");
          }
          if (cmd.method === "Target.setDiscoverTargets") {
            const discover = (cmd.params ?? {}) as { discover?: boolean };
            if (discover.discover === true) {
              ensureTargetEventsForClient(ws, "discover");
            }
          }
          if (cmd.method === "Target.attachToTarget") {
            const params = (cmd.params ?? {}) as { targetId?: string };
            const targetId = typeof params.targetId === "string" ? params.targetId : undefined;
            if (targetId) {
              const target = Array.from(connectedTargets.values()).find(
                (t) => t.targetId === targetId,
              );
              if (target) {
                ws.send(
                  JSON.stringify({
                    method: "Target.attachedToTarget",
                    params: {
                      sessionId: target.sessionId,
                      targetInfo: { ...target.targetInfo, attached: true },
                      waitingForDebugger: false,
                    },
                  } satisfies CdpEvent),
                );
              }
            }
          }

          sendResponseToCdp(ws, { id: cmd.id, sessionId: cmd.sessionId, result });
        } catch (err) {
          pruneStaleTargetsFromCommandFailure(cmd, err);
          sendResponseToCdp(ws, {
            id: cmd.id,
            sessionId: cmd.sessionId,
            error: { message: err instanceof Error ? err.message : String(err) },
          });
        }
      });

      ws.on("close", () => {
        cdpClients.delete(ws);
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.listen(info.port, bindHost, () => resolve());
        server.once("error", reject);
      });
    } catch (err) {
      if (
        isAddrInUseError(err) &&
        (await probeClawserRelay({
          baseUrl: info.baseUrl,
        }))
      ) {
        const existingRelay: ChromeExtensionRelayServer = {
          host: info.host,
          bindHost,
          port: info.port,
          baseUrl: info.baseUrl,
          cdpWsUrl: `ws://${info.host}:${info.port}/cdp`,
          extensionConnected: () => false,
          stop: async () => {
            relayRuntimeByPort.delete(info.port);
          },
        };
        relayRuntimeByPort.set(info.port, { server: existingRelay, relayAuthToken });
        return existingRelay;
      }
      throw err;
    }

    const addr = server.address() as AddressInfo | null;
    const port = addr?.port ?? info.port;
    const actualBindHost = addr?.address || bindHost;
    const host = info.host;
    const baseUrl = `${new URL(info.baseUrl).protocol}//${host}:${port}`;

    const relay: ChromeExtensionRelayServer = {
      host,
      bindHost: actualBindHost,
      port,
      baseUrl,
      cdpWsUrl: `ws://${host}:${port}/cdp`,
      extensionConnected,
      stop: async () => {
        relayRuntimeByPort.delete(port);
        clearExtensionDisconnectCleanupTimer();
        flushExtensionReconnectWaiters(false);
        for (const [, pending] of pendingExtension) {
          clearTimeout(pending.timer);
          pending.reject(new Error("server stopping"));
        }
        pendingExtension.clear();
        try {
          extensionWs?.close(1001, "server stopping");
        } catch {
          // ignore
        }
        for (const ws of cdpClients) {
          try {
            ws.close(1001, "server stopping");
          } catch {
            // ignore
          }
        }
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
        wssExtension.close();
        wssCdp.close();
      },
    };

    relayRuntimeByPort.set(port, { server: relay, relayAuthToken });
    return relay;
  })();
  relayInitByPort.set(info.port, initPromise);
  try {
    return await initPromise;
  } finally {
    relayInitByPort.delete(info.port);
  }
}

export async function stopChromeExtensionRelayServer(opts: { cdpUrl: string }): Promise<boolean> {
  const info = parseBaseUrl(opts.cdpUrl);
  const existing = relayRuntimeByPort.get(info.port);
  if (!existing) {
    return false;
  }
  await existing.server.stop();
  return true;
}
