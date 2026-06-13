import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getCodexAccessToken } from "./codex-auth";

export type CodingBackendType = "codex" | "claude-code" | "opencode";

export interface CodingBackendConfig {
  model?: string;
  timeout?: number;
}

export interface AppConfig {
  openaiApiKey: string;
  openaiBaseUrl: string;
  model: string;
  /** Root directory of the JSON file store (replaces the old databaseUrl). */
  dataDir: string;
  codingBackend: CodingBackendType;
  codingConfig: Record<CodingBackendType, CodingBackendConfig>;
}

const CONFIG_PATH = join(process.cwd(), "simple-harmonic.config.json");

const DEFAULT_CODING_CONFIG: Record<CodingBackendType, CodingBackendConfig> = {
  codex: {},
  "claude-code": {},
  opencode: {},
};

const DEFAULTS: AppConfig = {
  openaiApiKey: "",
  openaiBaseUrl: "https://api.openai.com/v1",
  model: "gpt-5.5",
  dataDir: join(process.cwd(), ".simple-harmonic", "data"),
  codingBackend: "codex",
  codingConfig: DEFAULT_CODING_CONFIG,
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

  const codingRaw =
    file.codingBackend ||
    process.env.SH_CODING_BACKEND ||
    DEFAULTS.codingBackend;
  const codingBackend = (
    ["codex", "claude-code", "opencode"].includes(codingRaw)
      ? codingRaw
      : DEFAULTS.codingBackend
  ) as CodingBackendType;

  const fileCodingConfig = (file as Record<string, unknown>).codingConfig as
    | Record<string, CodingBackendConfig>
    | undefined;
  const codingConfig: Record<CodingBackendType, CodingBackendConfig> = {
    codex: { ...DEFAULT_CODING_CONFIG.codex, ...fileCodingConfig?.codex },
    "claude-code": {
      ...DEFAULT_CODING_CONFIG["claude-code"],
      ...fileCodingConfig?.["claude-code"],
    },
    opencode: {
      ...DEFAULT_CODING_CONFIG.opencode,
      ...fileCodingConfig?.opencode,
    },
  };

  return {
    openaiApiKey: apiKey,
    openaiBaseUrl:
      file.openaiBaseUrl ||
      process.env.OPENAI_BASE_URL ||
      DEFAULTS.openaiBaseUrl,
    model: file.model || process.env.OPENAI_MODEL || DEFAULTS.model,
    dataDir: file.dataDir || process.env.SH_DATA_DIR || DEFAULTS.dataDir,
    codingBackend,
    codingConfig,
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
    dataDir: cfg.dataDir,
    hasOpenaiKey: cfg.openaiApiKey.length > 0,
    hasDataDir: cfg.dataDir.length > 0,
    apiKeySource: getApiKeySource(),
    codingBackend: cfg.codingBackend,
    codingConfig: cfg.codingConfig,
  };
}

function maskSecret(s: string): string {
  if (!s) return "";
  if (s.length <= 8) return "••••••••";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}
