import type { ResolvedBrowserProfile } from "../config.js";
import { toBrowserErrorResponse } from "../errors.js";
import type { PwAiModule } from "../pw-ai-module.js";
import { getPwAiModule as getPwAiModuleBase } from "../pw-ai-module.js";
import type { BrowserRouteContext, ProfileContext } from "../server-context.js";
import type { BrowserRequest, BrowserResponse } from "./types.js";
import { getProfileContext, jsonError } from "./utils.js";

export const SELECTOR_UNSUPPORTED_MESSAGE = [
  "Error: 'selector' is not supported. Use 'ref' from snapshot instead.",
  "",
  "Example workflow:",
  "1. snapshot action to get page state with refs",
  '2. act with ref: "e123" to interact with element',
  "",
  "This is more reliable for modern SPAs.",
].join("\n");

export function readBody(req: BrowserRequest): Record<string, unknown> {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  return body;
}

export function resolveTargetIdFromBody(body: Record<string, unknown>): string | undefined {
  const targetId = typeof body.targetId === "string" ? body.targetId.trim() : "";
  return targetId || undefined;
}

export function resolveTargetIdFromQuery(query: Record<string, unknown>): string | undefined {
  const targetId = typeof query.targetId === "string" ? query.targetId.trim() : "";
  return targetId || undefined;
}

export function handleRouteError(ctx: BrowserRouteContext, res: BrowserResponse, err: unknown) {
  const mapped = ctx.mapTabError(err);
  if (mapped) {
    return jsonError(res, mapped.status, mapped.message);
  }
  const browserMapped = toBrowserErrorResponse(err);
  if (browserMapped) {
    return jsonError(res, browserMapped.status, browserMapped.message);
  }
  jsonError(res, 500, String(err));
}

export function resolveProfileContext(
  req: BrowserRequest,
  res: BrowserResponse,
  ctx: BrowserRouteContext,
): ProfileContext | null {
  const profileCtx = getProfileContext(req, ctx);
  if ("error" in profileCtx) {
    jsonError(res, profileCtx.status, profileCtx.error);
    return null;
  }
  return profileCtx;
}

export async function getPwAiModule(): Promise<PwAiModule | null> {
  return await getPwAiModuleBase({ mode: "soft" });
}

export async function requirePwAi(
  res: BrowserResponse,
  feature: string,
): Promise<PwAiModule | null> {
  const mod = await getPwAiModule();
  if (mod) {
    return mod;
  }
  jsonError(
    res,
    501,
    [
      `Playwright is not available in this gateway build; '${feature}' is unsupported.`,
      "Install the full Playwright package (not playwright-core) and restart the gateway, or reinstall with browser support.",
      "Docs: /tools/browser#playwright-requirement",
    ].join("\n"),
  );
  return null;
}

type RouteTabContext = {
  profileCtx: ProfileContext;
  tab: Awaited<ReturnType<ProfileContext["ensureTabAvailable"]>>;
  cdpUrl: string;
};

type RouteTabPwContext = RouteTabContext & {
  pw: PwAiModule;
};

export async function closePlaywrightBrowserConnectionIfEphemeral(params: {
  profile: ResolvedBrowserProfile;
  cdpUrl: string;
  pw: Pick<PwAiModule, "closePlaywrightBrowserConnection">;
}): Promise<void> {
  if (params.profile.driver === "extension") {
    return;
  }
  await params.pw.closePlaywrightBrowserConnection({ cdpUrl: params.cdpUrl }).catch(() => {});
}

type RouteWithTabParams<T> = {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  targetId?: string;
  run: (ctx: RouteTabContext) => Promise<T>;
};

export async function withRouteTabContext<T>(
  params: RouteWithTabParams<T>,
): Promise<T | undefined> {
  const profileCtx = resolveProfileContext(params.req, params.res, params.ctx);
  if (!profileCtx) {
    return undefined;
  }
  try {
    const tab = await profileCtx.ensureTabAvailable(params.targetId);
    return await params.run({
      profileCtx,
      tab,
      cdpUrl: profileCtx.profile.cdpUrl,
    });
  } catch (err) {
    handleRouteError(params.ctx, params.res, err);
    return undefined;
  }
}

type RouteWithPwParams<T> = {
  req: BrowserRequest;
  res: BrowserResponse;
  ctx: BrowserRouteContext;
  targetId?: string;
  feature: string;
  keepAlive?: boolean;
  run: (ctx: RouteTabPwContext) => Promise<T>;
};

// Requests for one profile share pw-session's cached connectOverCDP client.
// A probe finishing must not disconnect a still-running action on that client.
const activePlaywrightRoutes = new Map<string, number>();

export async function withPlaywrightRouteContext<T>(
  params: RouteWithPwParams<T>,
): Promise<T | undefined> {
  return await withRouteTabContext({
    req: params.req,
    res: params.res,
    ctx: params.ctx,
    targetId: params.targetId,
    run: async ({ profileCtx, tab, cdpUrl }) => {
      const pw = await requirePwAi(params.res, params.feature);
      if (!pw) {
        return undefined as T | undefined;
      }
      const connectionKey = cdpUrl.replace(/\/$/, "");
      activePlaywrightRoutes.set(
        connectionKey,
        (activePlaywrightRoutes.get(connectionKey) ?? 0) + 1,
      );
      try {
        return await params.run({ profileCtx, tab, cdpUrl, pw });
      } finally {
        const remaining = (activePlaywrightRoutes.get(connectionKey) ?? 1) - 1;
        if (remaining > 0) {
          activePlaywrightRoutes.set(connectionKey, remaining);
        } else {
          activePlaywrightRoutes.delete(connectionKey);
          // Reusing the extension profile's CDP connection prevents Playwright
          // from creating a new utility world for every browser command.
          if (!params.keepAlive) {
            await closePlaywrightBrowserConnectionIfEphemeral({
              profile: profileCtx.profile,
              cdpUrl,
              pw,
            });
          }
        }
      }
    },
  });
}
