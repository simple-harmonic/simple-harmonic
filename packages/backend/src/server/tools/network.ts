// ---------------------------------------------------------------------------
// Network tools: http_fetch (safe, GET-only) and github_api (read safe /
// write destructive).
//
// http_fetch is read-only by construction: it only allows GET and caps the
// response, so it is not gated by the destructive kill switch. github_api
// permits GET without the switch; any mutating method (POST/PATCH/PUT/DELETE)
// requires toolsEnabled() AND a GITHUB_TOKEN (D18: creds via env for v0.1).
//
// Both reuse proxyFetch so they work behind the same proxy/IPv4 handling the
// rest of the app relies on.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDefinition, ToolImpl } from "../../lib/meta-agent/registry";
import { resolveConnector } from "../connectors";
import { proxyFetch } from "../proxy-fetch";
import { toolsEnabled } from "./sandbox";
import { assertPublicAndResolve } from "./url-guard";

const MAX_BODY_BYTES = 128 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

// --- http_fetch -------------------------------------------------------------

const httpFetchSchema = z.object({
  url: z.string().url().describe("Absolute public HTTPS URL to GET"),
});

export const httpFetchDef: ToolDefinition<typeof httpFetchSchema> = {
  name: "http_fetch",
  description:
    "HTTPS GET a public URL and return the response body as text (truncated if large). Read-only: only GET is supported; localhost and private-network targets are rejected.",
  category: "network",
  risk: "safe",
  schema: httpFetchSchema,
};

export const httpFetchImpl: ToolImpl<typeof httpFetchSchema> = async (args) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const { url, pinnedIp, family } = await assertPublicAndResolve(args.url);
    const res = await proxyFetch(
      url.toString(),
      { method: "GET", signal: controller.signal },
      { ip: pinnedIp, family },
    );
    const { text, bytesRead } = await readCappedText(res, MAX_BODY_BYTES);
    return {
      toolName: "http_fetch",
      success: res.ok,
      result: res.ok
        ? text
        : `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 2000)}`,
      action: {
        actionType: "http_fetched",
        payload: {
          url: url.toString(),
          status: res.status,
          bytes: bytesRead,
          // UI snippet (T8/D19).
          output: text.slice(0, 2_000),
        },
      },
    };
  } catch (err) {
    return {
      toolName: "http_fetch",
      success: false,
      result: `http_fetch failed for ${args.url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
};

// --- github_api -------------------------------------------------------------

const githubApiSchema = z.object({
  method: z
    .enum(["GET", "POST", "PATCH", "PUT", "DELETE"])
    .describe("HTTP method. Non-GET methods are destructive and gated."),
  path: z
    .string()
    .describe("GitHub API path, e.g. '/repos/owner/repo/issues'. Leading slash required."),
  body: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("JSON body for POST/PATCH/PUT requests"),
});

export const githubApiDef: ToolDefinition<typeof githubApiSchema> = {
  name: "github_api",
  description:
    "Call the GitHub REST API. GET is read-only; POST/PATCH/PUT/DELETE mutate and require the destructive-tools switch plus a GITHUB_TOKEN. Provide an API path like '/repos/owner/repo/issues'.",
  category: "network",
  risk: "destructive",
  isDestructive: (args) => args.method !== "GET",
  schema: githubApiSchema,
};

export const githubApiImpl: ToolImpl<typeof githubApiSchema> = async (args) => {
  const isWrite = args.method !== "GET";

  if (isWrite && !toolsEnabled()) {
    return {
      toolName: "github_api",
      success: false,
      result:
        "Mutating github_api calls are disabled. They require SH_ENABLE_TOOLS until the approval flow is enabled. GET requests are always allowed.",
    };
  }

  const token = resolveConnector("GITHUB_TOKEN");
  if (isWrite && !token) {
    return {
      toolName: "github_api",
      success: false,
      result: "GITHUB_TOKEN is not configured. Set it in .simple-harmonic/secrets.json or as an env var.",
    };
  }

  if (!args.path.startsWith("/")) {
    return {
      toolName: "github_api",
      success: false,
      result: `path must start with '/', got "${args.path}"`,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "simple-harmonic-agent",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (args.body) headers["Content-Type"] = "application/json";

    const ghUrl = `https://api.github.com${args.path}`;
    const { pinnedIp, family } = await assertPublicAndResolve(ghUrl);
    const res = await proxyFetch(
      ghUrl,
      {
        method: args.method,
        headers,
        body: args.body ? JSON.stringify(args.body) : undefined,
        signal: controller.signal,
      },
      { ip: pinnedIp, family },
    );
    const { text } = await readCappedText(res, MAX_BODY_BYTES);
    return {
      toolName: "github_api",
      success: res.ok,
      result: res.ok
        ? text
        : `GitHub ${res.status} ${res.statusText}: ${text.slice(0, 2000)}`,
      action: {
        actionType: "github_api_called",
        payload: {
          method: args.method,
          path: args.path,
          status: res.status,
          // UI snippet (T8/D19).
          output: text.slice(0, 2_000),
        },
      },
    };
  } catch (err) {
    return {
      toolName: "github_api",
      success: false,
      result: `github_api failed for ${args.method} ${args.path}: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    clearTimeout(timer);
  }
};

async function readCappedText(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; bytesRead: number }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", bytesRead: 0 };

  const chunks: Buffer[] = [];
  let bytesRead = 0;
  let bytesKept = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    bytesRead += chunk.byteLength;
    const remaining = maxBytes - bytesKept;
    if (remaining > 0) {
      const kept = chunk.subarray(0, remaining);
      chunks.push(kept);
      bytesKept += kept.byteLength;
    }
    if (bytesKept >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }

  return { text: Buffer.concat(chunks).toString("utf-8"), bytesRead };
}
