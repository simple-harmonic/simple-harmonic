import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const TOKEN_URL = "https://auth.openai.com/oauth/token";

interface CodexAuthFile {
  auth_mode: string;
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
  last_refresh: string;
}

export interface CodexAuthStatus {
  found: boolean;
  authMode: string | null;
  email: string | null;
  plan: string | null;
  accountId: string | null;
  lastRefresh: string | null;
  tokenExpiry: string | null;
  hasAccessToken: boolean;
}

function codexAuthPath(): string {
  const home =
    process.env.CODEX_HOME || join(process.env.HOME || "~", ".codex");
  return join(home, "auth.json");
}

function readCodexAuth(): CodexAuthFile | null {
  const path = codexAuthPath();
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf-8"));
    }
  } catch {
    // not available
  }
  return null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1] + "=".repeat(4 - (parts[1].length % 4));
    return JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

export function getCodexAuthStatus(): CodexAuthStatus {
  const auth = readCodexAuth();
  if (!auth || !auth.tokens?.access_token) {
    return {
      found: false,
      authMode: null,
      email: null,
      plan: null,
      accountId: null,
      lastRefresh: null,
      tokenExpiry: null,
      hasAccessToken: false,
    };
  }

  const jwt = decodeJwtPayload(auth.tokens.access_token);
  const profile = jwt?.["https://api.openai.com/profile"] as
    | Record<string, string>
    | undefined;
  const authInfo = jwt?.["https://api.openai.com/auth"] as
    | Record<string, string>
    | undefined;
  const exp = jwt?.exp as number | undefined;

  return {
    found: true,
    authMode: auth.auth_mode || null,
    email: profile?.email || null,
    plan: authInfo?.chatgpt_plan_type || null,
    accountId: auth.tokens.account_id || null,
    lastRefresh: auth.last_refresh || null,
    tokenExpiry: exp ? new Date(exp * 1000).toISOString() : null,
    hasAccessToken: true,
  };
}

export function getCodexAccessToken(): string | null {
  const auth = readCodexAuth();
  return auth?.tokens?.access_token || null;
}

export interface CodexModel {
  slug: string;
  displayName: string;
  description: string;
  priority: number;
  supportedInApi: boolean;
}

export function getCodexModels(): CodexModel[] {
  const home =
    process.env.CODEX_HOME || join(process.env.HOME || "~", ".codex");
  const cachePath = join(home, "models_cache.json");
  try {
    if (!existsSync(cachePath)) return [];
    const raw = JSON.parse(readFileSync(cachePath, "utf-8"));
    const models: CodexModel[] = [];
    for (const m of raw.models || raw) {
      if (!m.slug) continue;
      models.push({
        slug: m.slug,
        displayName: m.display_name || m.slug,
        description: m.description || "",
        priority: typeof m.priority === "number" ? m.priority : 999,
        supportedInApi: m.supported_in_api !== false,
      });
    }
    // Sort by priority ascending, filter to API-supported
    return models
      .filter((m) => m.supportedInApi)
      .sort((a, b) => a.priority - b.priority);
  } catch {
    return [];
  }
}

export async function refreshCodexToken(): Promise<{
  ok: boolean;
  accessToken?: string;
  error?: string;
}> {
  const auth = readCodexAuth();
  if (!auth?.tokens?.refresh_token) {
    return { ok: false, error: "No Codex refresh token found" };
  }

  try {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: auth.tokens.refresh_token,
      client_id: CODEX_CLIENT_ID,
    });

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text();
      return {
        ok: false,
        error: `Refresh failed (${res.status}): ${text.slice(0, 200)}`,
      };
    }

    const data = await res.json();
    if (!data.access_token) {
      return { ok: false, error: "No access_token in refresh response" };
    }

    // Update the local auth.json so Codex CLI stays in sync
    const path = codexAuthPath();
    const updated: CodexAuthFile = {
      ...auth,
      tokens: {
        ...auth.tokens,
        access_token: data.access_token,
        id_token: data.id_token || auth.tokens.id_token,
        refresh_token: data.refresh_token || auth.tokens.refresh_token,
      },
      last_refresh: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(updated, null, 2) + "\n");

    return { ok: true, accessToken: data.access_token };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Refresh failed",
    };
  }
}
