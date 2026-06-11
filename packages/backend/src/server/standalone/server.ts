// ---------------------------------------------------------------------------
// Standalone HTTP host for the backend API — no Next.js required.
//
// Bridges node:http to the web-standard (Request) => Response handlers in
// ../api/** and enforces the same operator gate as src/proxy.ts does for the
// Next app: /api/tick runs its own cron-secret check, /api/login must stay
// reachable so the operator can authenticate, everything else requires
// OPERATOR_PASSWORD (permissive in local dev when unset, fails closed in
// production — see operator-auth.ts).
// ---------------------------------------------------------------------------

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { isOperatorAuthorized, isProductionRuntime } from "../operator-auth";
import { matchPath, type RouteHandler, type RouteModule, routes } from "./routes";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

function isHttpMethod(m: string): m is HttpMethod {
  return (HTTP_METHODS as readonly string[]).includes(m);
}

/** RFC 9110 Allow header for a route module (405 and OPTIONS responses). */
function allowHeader(module: RouteModule): string {
  const methods = HTTP_METHODS.filter((m) => typeof module[m] === "function");
  const allow: string[] = [...methods, "OPTIONS"];
  if (methods.includes("GET")) allow.push("HEAD");
  return allow.join(", ");
}

/** Convert a node IncomingMessage into a web-standard Request. */
function toRequest(req: IncomingMessage): Request {
  const url = `http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Readable.toWeb(req) as unknown as RequestInit["body"];
    init.duplex = "half"; // required for streamed request bodies
  }
  return new Request(url, init);
}

/** Write a web-standard Response back to the node ServerResponse (streams pass through). */
function sendResponse(nodeRes: ServerResponse, response: Response): void {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, key) => {
    if (key !== "set-cookie") headers[key] = value;
  });
  const setCookies = response.headers.getSetCookie();
  if (setCookies.length > 0) headers["set-cookie"] = setCookies;
  nodeRes.writeHead(response.status, headers);
  if (!response.body) {
    nodeRes.end();
    return;
  }
  const stream = Readable.fromWeb(response.body as unknown as NodeWebReadableStream);
  stream.on("error", () => nodeRes.destroy());
  // pipe() does not destroy the source when the client disconnects; without
  // this an aborted SSE response (e.g. /api/chat) would keep streaming from
  // the LLM into a dead socket.
  nodeRes.on("close", () => stream.destroy());
  stream.pipe(nodeRes);
}

/**
 * The operator gate, mirroring src/proxy.ts. Returns a Response to short-
 * circuit with, or null to let the request through.
 */
async function gate(req: Request, pathname: string): Promise<Response | null> {
  // The tick endpoint runs its own cron-secret check (cron callers carry no
  // operator cookie); login must stay reachable to authenticate.
  if (pathname === "/api/tick" || pathname.startsWith("/api/tick/")) return null;
  if (pathname === "/api/login" || pathname.startsWith("/api/login/")) return null;

  const password = process.env.OPERATOR_PASSWORD;
  if (!password) {
    // No operator password configured: fail closed in production, open in dev.
    if (isProductionRuntime()) {
      return Response.json({ error: "OPERATOR_PASSWORD not configured" }, { status: 503 });
    }
    return null;
  }
  if (await isOperatorAuthorized(req, password)) return null;
  return Response.json({ error: "unauthorized" }, { status: 401 });
}

async function dispatch(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  if (!pathname.startsWith("/api/")) {
    if (pathname === "/") {
      // No endpoint listing here: "/" is reachable without auth (the Next
      // proxy gates every page; this host only gates /api/*).
      return Response.json({ name: "@simple-harmonic/backend", mode: "standalone" });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  const denied = await gate(request, pathname);
  if (denied) return denied;

  for (const { pattern, module } of routes) {
    const params = matchPath(pattern, pathname);
    if (!params) continue;

    const method = request.method.toUpperCase();
    const allow = allowHeader(module as RouteModule);
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { allow } });
    }
    // Next serves HEAD through the GET handler; mirror that.
    const lookup = method === "HEAD" ? "GET" : method;
    const handler = isHttpMethod(lookup) ? (module as RouteModule)[lookup] : undefined;
    if (!handler) {
      return Response.json({ error: "method not allowed" }, { status: 405, headers: { allow } });
    }
    const response = await (handler as RouteHandler)(request, {
      params: Promise.resolve(params),
    });
    if (method === "HEAD") {
      response.body?.cancel().catch(() => {});
      return new Response(null, { status: response.status, headers: response.headers });
    }
    return response;
  }
  return Response.json({ error: "not found" }, { status: 404 });
}

/** Build the standalone backend server (caller decides the port and lifecycle). */
export function createBackendServer(): Server {
  return createServer(async (req, res) => {
    try {
      const response = await dispatch(toRequest(req));
      sendResponse(res, response);
    } catch (err) {
      console.error(`[server] ${req.method} ${req.url} failed:`, err);
      if (!res.headersSent) {
        sendResponse(res, Response.json({ error: "internal error" }, { status: 500 }));
      } else {
        res.destroy();
      }
    }
  });
}
