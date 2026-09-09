import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { callGatewayFromCli } from "../src/cli/gateway-rpc.js";

describe("browser control daemon HTTP responses", () => {
  const server = createServer((req, res) => {
    const fixtures: Record<string, [number, string]> = {
      "/unauthorized": [401, "Unauthorized"],
      "/forbidden": [403, "Access denied"],
      "/proxy-error": [502, "<html>Bad Gateway</html>"],
      "/empty-error": [503, ""],
      "/json-error": [400, '{"error":"Unknown browser profile"}'],
      "/unauthorized-json": [401, '{"error":"Unauthorized"}'],
      "/forbidden-json": [403, '{"error":"Forbidden"}'],
      "/http-network-keyword-body": [502, "upstream fetch failed: econnrefused while proxying"],
      "/success": [200, '{"tabs":[{"id":"tab-1"}]}'],
      "/empty-success": [204, ""],
      "/malformed-success": [200, "invalid JSON"],
    };
    const [status, body] = fixtures[req.url ?? ""] ?? [404, "Not found"];
    res.writeHead(status);
    res.end(body);
  });
  let origin: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a local TCP test server");
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  });

  function request(path: string) {
    return callGatewayFromCli("browser.request", { json: true }, { path: `${origin}${path}` });
  }

  it.each([
    ["/unauthorized", /HTTP 401.*Unauthorized/],
    ["/forbidden", /HTTP 403.*Access denied/],
    ["/proxy-error", /HTTP 502.*<html>Bad Gateway<\/html>/],
    ["/empty-error", /HTTP 503/],
  ])("preserves the HTTP failure and body for %s", async (path, message) => {
    await expect(request(path)).rejects.toThrow(message);
  });

  it("preserves structured JSON error messages", async () => {
    await expect(request("/json-error")).rejects.toThrow("Unknown browser profile");
  });

  it.each([
    ["/unauthorized-json", /HTTP 401: Unauthorized/],
    ["/forbidden-json", /HTTP 403: Forbidden/],
  ])("includes the HTTP status for JSON error bodies on %s", async (path, message) => {
    await expect(request(path)).rejects.toThrow(message);
  });

  it("keeps an HTTP error as an HTTP error even when its body mentions network keywords", async () => {
    // Regression: a received non-2xx response must not fall through to the local
    // in-process fallback just because the body text contains "fetch failed" /
    // "econnrefused" style keywords.
    await expect(request("/http-network-keyword-body")).rejects.toThrow(/HTTP 502:.*fetch failed/);
  });

  it("returns parsed JSON on success", async () => {
    await expect(request("/success")).resolves.toEqual({ tabs: [{ id: "tab-1" }] });
  });

  it("accepts an empty successful response", async () => {
    await expect(request("/empty-success")).resolves.toBeUndefined();
  });

  it("still rejects malformed JSON on success", async () => {
    await expect(request("/malformed-success")).rejects.toBeInstanceOf(SyntaxError);
  });
});
