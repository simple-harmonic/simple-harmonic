// ---------------------------------------------------------------------------
// Single SSRF egress policy. Every agent-driven outbound fetch (http_fetch,
// github_api, custom API skills) goes through assertPublicAndResolve BEFORE any
// request is sent — and crucially, before a connector bearer token is attached.
//
// The old per-tool check validated the hostname STRING only, so a domain whose
// A-record points at 169.254.169.254 (cloud metadata) or 127.0.0.1 sailed
// through. Here we resolve DNS first, reject if ANY returned address is private
// (covers a mixed public+private rebind set), and return a PINNED public IP so
// the connection can't be re-resolved to a private host at connect time (the
// DNS-rebinding TOCTOU). The hostname is preserved for TLS SNI + cert checks;
// only DNS resolution is overridden (see proxy-fetch.ts).
// ---------------------------------------------------------------------------

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

export function isPrivateIpv4(ip: string): boolean {
  const [a, b] = ip.split(".").map((part) => Number.parseInt(part, 10));
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

export function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe80")) return true;
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice("::ffff:".length));
  }
  return false;
}

/** True if `host` is an IP literal in a private/loopback/link-local/metadata range. */
export function isPrivateIp(host: string): boolean {
  const v = isIP(host);
  if (v === 4) return isPrivateIpv4(host);
  if (v === 6) return isPrivateIpv6(host);
  return false; // not an IP literal — caller must resolve DNS first
}

export interface PinnedTarget {
  url: URL;
  pinnedIp: string;
  family: 4 | 6;
}

/**
 * Validate a URL for outbound agent use and return a pinned public IP. Rejects
 * non-https, embedded credentials, localhost, IP literals in private ranges,
 * and any DNS name that resolves to (or includes) a private address.
 */
export async function assertPublicAndResolve(rawUrl: string): Promise<PinnedTarget> {
  const url = new URL(rawUrl);
  if (url.protocol !== "https:") {
    throw new Error("Only https:// URLs are allowed");
  }
  if (url.username || url.password) {
    throw new Error("Credentials in URLs are not allowed");
  }

  const host = stripIpv6Brackets(url.hostname.toLowerCase().replace(/\.$/, ""));
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("Localhost URLs are not allowed");
  }

  // IP literal: validate and pin directly (no DNS).
  const literalVersion = isIP(host);
  if (literalVersion) {
    if (isPrivateIp(host)) {
      throw new Error("Private-network URLs are not allowed");
    }
    return { url, pinnedIp: host, family: literalVersion === 6 ? 6 : 4 };
  }

  // DNS name: resolve ALL addresses and reject if any is private, so a mixed
  // public+private record set can't sneak a private target past us.
  let addrs: Array<{ address: string; family: number }>;
  try {
    addrs = await lookup(host, { all: true });
  } catch {
    throw new Error(`DNS resolution failed for ${host}`);
  }
  if (addrs.length === 0) {
    throw new Error(`No DNS records for ${host}`);
  }
  for (const a of addrs) {
    if (isPrivateIp(a.address)) {
      throw new Error("Host resolves to a private-network address");
    }
  }

  // Prefer a public IPv4 (matches the curl-like v4 pin proxy-fetch relies on to
  // avoid v6 tunnel hangs); fall back to the first public address otherwise.
  const chosen = addrs.find((a) => a.family === 4) ?? addrs[0];
  return { url, pinnedIp: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}
