// ---------------------------------------------------------------------------
// API tool runtime: turns a CustomTool row into a registry-compatible
// ToolDefinition + ToolImpl pair.
//
// Each custom API tool becomes a named tool that agents can call. The tool
// makes authenticated HTTP requests against the configured base URL, using
// a connector for auth. Methods are restricted to the allowedMethods set.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDefinition, ToolImpl } from "../../lib/meta-agent/registry";
import type { ApiToolConfig } from "../db/schema";
import { resolveConnector } from "../connectors";
import { proxyFetch } from "../proxy-fetch";
import { assertPublicAndResolve } from "./url-guard";

const MAX_BODY_BYTES = 128 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

export function buildApiToolDef(
  name: string,
  description: string,
  config: ApiToolConfig,
): ToolDefinition {
  const methodEnum = config.allowedMethods.length > 0
    ? config.allowedMethods
    : ["GET"];

  const schema = z.object({
    method: z
      .enum(methodEnum as [string, ...string[]])
      .describe(`HTTP method. Allowed: ${methodEnum.join(", ")}`),
    path: z
      .string()
      .describe(
        `API path (appended to ${config.baseUrl}${config.pathPrefix || ""}). Include leading slash.`,
      ),
    body: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("JSON body for POST/PATCH/PUT requests"),
    query: z
      .record(z.string(), z.string())
      .optional()
      .describe("Query parameters as key-value pairs"),
  });

  return {
    name,
    description,
    category: "network",
    risk: "destructive",
    isDestructive: (args) => (args as { method: string }).method !== "GET",
    schema,
  };
}

export function buildApiToolImpl(
  toolName: string,
  config: ApiToolConfig,
): ToolImpl {
  return async (args, ctx) => {
    const { method, path, body, query } = args as {
      method: string;
      path: string;
      body?: Record<string, unknown>;
      query?: Record<string, string>;
    };

    // Resolve auth connector
    let authValue: string | null = null;
    if (config.connectorKey) {
      authValue = resolveConnector(config.connectorKey);
      if (!authValue && method !== "GET") {
        return {
          toolName,
          success: false,
          result: `Connector "${config.connectorKey}" is not configured. Set it in .simple-harmonic/secrets.json or as an env var.`,
        };
      }
    }

    // Build URL
    const prefix = config.pathPrefix || "";
    const fullPath = path.startsWith("/") ? path : `/${path}`;
    const url = new URL(`${config.baseUrl}${prefix}${fullPath}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        url.searchParams.set(k, v);
      }
    }

    // SSRF guard BEFORE attaching the connector secret: a skill whose baseUrl
    // resolves to an internal/metadata host must fail here so the bearer token
    // is never sent off-box.
    let pin: { ip: string; family: 4 | 6 };
    try {
      const checked = await assertPublicAndResolve(url.toString());
      pin = { ip: checked.pinnedIp, family: checked.family };
    } catch (err) {
      return {
        toolName,
        success: false,
        result: `${toolName} blocked: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // Build headers
    const headers: Record<string, string> = {
      "User-Agent": "simple-harmonic-agent",
      ...config.defaultHeaders,
    };
    if (authValue) {
      const headerName = config.authHeader || "Authorization";
      const prefix2 = config.authPrefix ?? "Bearer";
      headers[headerName] = prefix2 ? `${prefix2} ${authValue}` : authValue;
    }
    if (body) {
      headers["Content-Type"] = "application/json";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await proxyFetch(
        url.toString(),
        {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        },
        pin,
      );

      const text = await readCapped(res, MAX_BODY_BYTES);

      return {
        toolName,
        success: res.ok,
        result: res.ok
          ? text
          : `HTTP ${res.status} ${res.statusText}: ${text.slice(0, 2000)}`,
        action: {
          actionType: "api_tool_called",
          payload: {
            tool: toolName,
            method,
            path: fullPath,
            status: res.status,
            output: text.slice(0, 2_000),
          },
        },
      };
    } catch (err) {
      return {
        toolName,
        success: false,
        result: `${toolName} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      clearTimeout(timer);
    }
  };
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";

  const chunks: Buffer[] = [];
  let bytesKept = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    const remaining = maxBytes - bytesKept;
    if (remaining > 0) {
      chunks.push(chunk.subarray(0, remaining));
      bytesKept += Math.min(chunk.byteLength, remaining);
    }
    if (bytesKept >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }

  return Buffer.concat(chunks).toString("utf-8");
}
