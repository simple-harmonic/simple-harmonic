import { execSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import type { LookupFunction } from "node:net";

/** A pre-validated public IP to pin the connection to (anti-rebinding). */
export interface PinnedAddress {
  ip: string;
  family: 4 | 6;
}

// Read the macOS system HTTPS proxy via `scutil --proxy`. Cached for the
// lifetime of the process. Returns null on non-macOS or when no proxy is
// configured. Used as a fallback when HTTPS_PROXY env var isn't set — many
// users start `next dev` before exporting their proxy env.
let cachedSystemProxy: string | null | undefined;
function getSystemProxyMac(): string | null {
  if (cachedSystemProxy !== undefined) return cachedSystemProxy;
  cachedSystemProxy = null;
  if (process.platform !== "darwin") return null;
  try {
    const out = execSync("scutil --proxy", { timeout: 1000, encoding: "utf-8" });
    const httpsEnabled = /HTTPSEnable\s*:\s*1/.test(out);
    if (!httpsEnabled) return null;
    const hostMatch = out.match(/HTTPSProxy\s*:\s*(\S+)/);
    const portMatch = out.match(/HTTPSPort\s*:\s*(\d+)/);
    if (hostMatch && portMatch) {
      cachedSystemProxy = `http://${hostMatch[1]}:${portMatch[1]}`;
      return cachedSystemProxy;
    }
  } catch {
    // scutil missing / failed — silently skip
  }
  return null;
}

// Why https.request and not global fetch:
// Some hosts (including chatgpt.com on certain networks) advertise AAAA
// records that route to unreachable IPv6 tunnels (e.g. Teredo
// 2001::/32 addresses). Node's undici-backed global fetch tries whichever
// address DNS returns first and hangs on the v6 attempt for 10s+. curl
// avoids this because it falls back to v4 quickly. We pin `family: 4` so
// connections behave like curl.
function fetchViaHttps(
  url: string,
  init: RequestInit & { signal?: AbortSignal } = {},
  pin?: PinnedAddress,
): Promise<Response> {
  const target = new URL(url);
  // When pinned, override DNS resolution to the pre-validated public IP. net
  // still uses target.hostname for TLS SNI + cert verification, so this closes
  // the rebinding TOCTOU without weakening cert checks.
  const pinnedLookup: LookupFunction | undefined = pin
    ? (_hostname, _options, callback) => callback(null, pin.ip, pin.family)
    : undefined;
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (init.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }

    // Compute Content-Length when we have a body. Without this https.request
    // doesn't frame the request properly and the server waits forever for
    // more bytes, which manifests as a "socket hang up" when our abort fires.
    let bodyBuffer: Buffer | null = null;
    if (init.body != null) {
      if (typeof init.body === "string") {
        bodyBuffer = Buffer.from(init.body, "utf-8");
      } else if (init.body instanceof Buffer) {
        bodyBuffer = init.body;
      } else if (init.body instanceof Uint8Array) {
        bodyBuffer = Buffer.from(init.body);
      }
      if (bodyBuffer && headers["Content-Length"] == null && headers["content-length"] == null) {
        headers["Content-Length"] = String(bodyBuffer.byteLength);
      }
    }

    const req = https.request(
      {
        hostname: target.hostname,
        port: Number(target.port) || 443,
        path: target.pathname + target.search,
        method: init.method || "GET",
        headers,
        // Without a pin, keep the legacy v4 pin (avoids v6 tunnel hangs).
        family: pin?.family ?? 4,
        ...(pinnedLookup ? { lookup: pinnedLookup } : {}),
      },
      (res) => {
        const responseHeaders = new Headers();
        for (const [key, val] of Object.entries(res.headers)) {
          if (val) responseHeaders.set(key, Array.isArray(val) ? val.join(", ") : val);
        }
        const readable = new ReadableStream({
          start(controller) {
            res.on("data", (chunk: Buffer) => controller.enqueue(chunk));
            res.on("end", () => controller.close());
            res.on("error", (err) => controller.error(err));
          },
        });
        resolve(
          new Response(readable, {
            status: res.statusCode || 200,
            statusText: res.statusMessage || "",
            headers: responseHeaders,
          }),
        );
      },
    );

    req.on("error", reject);

    if (init.signal) {
      init.signal.addEventListener("abort", () => req.destroy());
    }

    if (bodyBuffer) req.write(bodyBuffer);
    req.end();
  });
}

/**
 * Proxy-aware fetch for Node.js.
 * Respects HTTPS_PROXY / HTTP_PROXY env vars via HTTP CONNECT tunnel.
 * Falls back to a direct IPv4-pinned https.request when no proxy is set.
 */
export async function proxyFetch(
  url: string,
  init: RequestInit & { signal?: AbortSignal } = {},
  pin?: PinnedAddress,
): Promise<Response> {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    // Fallback: macOS system proxy (set in System Settings → Network).
    // Picks up VPN / V2Ray / sing-box configs that aren't exported as env
    // vars to the Next.js process.
    getSystemProxyMac();

  if (!proxyUrl) {
    return fetchViaHttps(url, init, pin);
  }
  // Proxy-tunnel path: the proxy resolves the target host itself, so an IP pin
  // is not applicable here (a corporate proxy is already a trust boundary).

  const target = new URL(url);
  const proxy = new URL(proxyUrl);

  // Create CONNECT tunnel through proxy
  const socket = await new Promise<import("node:net").Socket>((resolve, reject) => {
    const req = http.request({
      hostname: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: "CONNECT",
      path: `${target.hostname}:${target.port || 443}`,
      timeout: 10000,
    });

    req.on("connect", (_res, socket) => {
      resolve(socket);
    });

    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Proxy CONNECT timeout"));
    });

    if (init.signal) {
      init.signal.addEventListener("abort", () => req.destroy());
    }

    req.end();
  });

  // Make HTTPS request through the tunnel
  return new Promise<Response>((resolve, reject) => {
    const agent = new https.Agent({ socket, rejectUnauthorized: true });
    const headers: Record<string, string> = {};
    if (init.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) {
        headers[k] = v;
      }
    }

    const req = https.request(
      {
        hostname: target.hostname,
        port: Number(target.port) || 443,
        path: target.pathname + target.search,
        method: init.method || "GET",
        headers,
        agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        const responseHeaders = new Headers();
        for (const [key, val] of Object.entries(res.headers)) {
          if (val) responseHeaders.set(key, Array.isArray(val) ? val.join(", ") : val);
        }

        // For streaming, build a ReadableStream from the response
        const readable = new ReadableStream({
          start(controller) {
            res.on("data", (chunk: Buffer) => {
              controller.enqueue(chunk);
              chunks.push(chunk);
            });
            res.on("end", () => controller.close());
            res.on("error", (err) => controller.error(err));
          },
        });

        resolve(
          new Response(readable, {
            status: res.statusCode || 200,
            statusText: res.statusMessage || "",
            headers: responseHeaders,
          }),
        );
      },
    );

    req.on("error", reject);

    if (init.signal) {
      init.signal.addEventListener("abort", () => req.destroy());
    }

    if (init.body) {
      req.write(init.body);
    }
    req.end();
  });
}
