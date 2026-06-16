import net from "node:net";
import { isLoopbackIpAddress } from "../shared/net/ip.js";

export function isLoopbackAddress(ip: string | undefined): boolean {
  return isLoopbackIpAddress(ip);
}

/**
 * Check if a hostname or IP refers to the local machine.
 * Handles: localhost, 127.x.x.x, ::1, [::1], ::ffff:127.x.x.x
 * Note: 0.0.0.0 and :: are NOT loopback - they bind to all interfaces.
 */
export function isLoopbackHost(host: string): boolean {
  const parsed = parseHostForAddressChecks(host);
  if (!parsed) {
    return false;
  }
  if (parsed.isLocalhost) {
    return true;
  }
  return isLoopbackAddress(parsed.unbracketedHost);
}

function parseHostForAddressChecks(
  host: string,
): { isLocalhost: boolean; unbracketedHost: string } | null {
  if (!host) {
    return null;
  }
  const normalizedHost = host.trim().toLowerCase();
  if (normalizedHost === "localhost") {
    return { isLocalhost: true, unbracketedHost: normalizedHost };
  }
  if (net.isIP(normalizedHost) !== 0) {
    return { isLocalhost: false, unbracketedHost: normalizedHost };
  }
  return {
    isLocalhost: false,
    unbracketedHost:
      normalizedHost.startsWith("[") && normalizedHost.endsWith("]")
        ? normalizedHost.slice(1, -1)
        : normalizedHost,
  };
}
