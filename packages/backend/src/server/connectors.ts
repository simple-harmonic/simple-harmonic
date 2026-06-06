// ---------------------------------------------------------------------------
// Connector resolution: flat files + env var fallback.
//
// Connectors are JSON files in .simple-harmonic/connectors/<KEY>.json.
// Each file stores metadata (name, description, type). The actual secret
// value resolves from:
//   1. .simple-harmonic/secrets.json (gitignored, local-only)
//   2. process.env
//
// Agents discover connectors by reading files with read_file. No VFS, no
// DB, no manage_connector tool needed.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { toolsRoot } from "./tools/sandbox";
import { assertValidConnectorKey } from "./validation";

const DIR = ".simple-harmonic/connectors";
const SECRETS_FILE = ".simple-harmonic/secrets.json";

export interface ConnectorMeta {
  name: string;
  description: string;
  type: "api_key" | "oauth_token" | "env_var";
  key: string;
}

function connectorsDir(): string {
  return join(toolsRoot(), DIR);
}

function secretsPath(): string {
  return join(toolsRoot(), SECRETS_FILE);
}

function readSecrets(): Record<string, string> {
  try {
    const p = secretsPath();
    if (existsSync(p)) {
      return JSON.parse(readFileSync(p, "utf-8"));
    }
  } catch {
    // corrupted, treat as empty
  }
  return {};
}

/**
 * Resolve a connector value by key.
 * Priority: secrets.json > process.env > null.
 */
export function resolveConnector(key: string): string | null {
  const secrets = readSecrets();
  if (secrets[key]) return secrets[key];
  return process.env[key] ?? null;
}

/**
 * List all connector metadata from .simple-harmonic/connectors/.
 */
export function listConnectorMetas(): ConnectorMeta[] {
  const dir = connectorsDir();
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const metas: ConnectorMeta[] = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, file), "utf-8"));
      metas.push({
        name: raw.name || basename(file, ".json"),
        description: raw.description || "",
        type: raw.type || "api_key",
        key: raw.key || basename(file, ".json"),
      });
    } catch {
      // skip malformed files
    }
  }
  return metas;
}

/**
 * Write a connector metadata file + optionally store the secret.
 */
export function saveConnector(
  meta: ConnectorMeta,
  secretValue?: string,
): void {
  assertValidConnectorKey(meta.key);
  const dir = connectorsDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${meta.key}.json`),
    JSON.stringify(meta, null, 2) + "\n",
  );

  if (secretValue) {
    const secrets = readSecrets();
    secrets[meta.key] = secretValue;
    const p = secretsPath();
    mkdirSync(join(toolsRoot(), ".simple-harmonic"), { recursive: true });
    writeFileSync(p, JSON.stringify(secrets, null, 2) + "\n");
  }
}

/**
 * Delete a connector metadata file and its secret.
 */
export function deleteConnectorByKey(key: string): boolean {
  assertValidConnectorKey(key);
  const file = join(connectorsDir(), `${key}.json`);
  let deleted = false;
  if (existsSync(file)) {
    unlinkSync(file);
    deleted = true;
  }

  const secrets = readSecrets();
  if (secrets[key]) {
    delete secrets[key];
    writeFileSync(secretsPath(), JSON.stringify(secrets, null, 2) + "\n");
  }

  return deleted;
}
