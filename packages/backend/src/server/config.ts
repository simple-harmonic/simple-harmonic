import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCodexAccessToken } from "./codex-auth";

export interface AppConfig {
  openaiApiKey: string;
  openaiBaseUrl: string;
  model: string;
  databaseUrl: string;
}

const CONFIG_PATH = join(process.cwd(), "simple-harmonic.config.json");

const DEFAULTS: AppConfig = {
  openaiApiKey: "",
  openaiBaseUrl: "https://api.openai.com/v1",
  model: "o4-mini",
  databaseUrl: "postgresql://localhost:5432/simple_harmonic",
};

function readFile(): Partial<AppConfig> {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    }
  } catch {
    // corrupted file, use defaults
  }
  return {};
}

export function getConfig(): AppConfig {
  const file = readFile();
  // Resolve API key: explicit config > env var > Codex CLI token
  const apiKey =
    file.openaiApiKey ||
    process.env.OPENAI_API_KEY ||
    getCodexAccessToken() ||
    DEFAULTS.openaiApiKey;

  return {
    openaiApiKey: apiKey,
    openaiBaseUrl: file.openaiBaseUrl || process.env.OPENAI_BASE_URL || DEFAULTS.openaiBaseUrl,
    model: file.model || process.env.OPENAI_MODEL || DEFAULTS.model,
    databaseUrl: file.databaseUrl || process.env.DATABASE_URL || DEFAULTS.databaseUrl,
  };
}

/** Which source the API key came from */
export function getApiKeySource(): "config" | "env" | "codex" | "none" {
  const file = readFile();
  if (file.openaiApiKey) return "config";
  if (process.env.OPENAI_API_KEY) return "env";
  if (getCodexAccessToken()) return "codex";
  return "none";
}

export function setConfig(partial: Partial<AppConfig>): AppConfig {
  const current = readFile();
  const merged = { ...current, ...partial };
  writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`);
  return getConfig();
}

/** Return config with secrets masked for the client */
export function getSafeConfig() {
  const cfg = getConfig();
  return {
    openaiApiKey: maskSecret(cfg.openaiApiKey),
    openaiBaseUrl: cfg.openaiBaseUrl,
    model: cfg.model,
    databaseUrl: maskDbUrl(cfg.databaseUrl),
    hasOpenaiKey: cfg.openaiApiKey.length > 0,
    hasDatabase: cfg.databaseUrl.length > 0,
    apiKeySource: getApiKeySource(),
  };
}

function maskSecret(s: string): string {
  if (!s) return "";
  if (s.length <= 8) return "••••••••";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

function maskDbUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) {
      u.password = "••••";
    }
    return u.toString();
  } catch {
    return url;
  }
}
