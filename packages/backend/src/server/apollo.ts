// ---------------------------------------------------------------------------
// Apollo — encrypted secrets manager for Simple Harmonic.
//
// Secrets are AES-256-GCM encrypted at rest in .apollo/vault.enc (gitignored).
// A master key (APOLLO_MASTER_KEY env var) encrypts/decrypts. If no master key
// is set, Apollo auto-generates one and stores it in .apollo/master.key
// (also gitignored, local-only).
//
// On server start, call apollo.load() to decrypt all secrets into process.env.
// Agents access them indirectly via resolveConnector(), which falls back to
// process.env. They never see the vault file (blocked by isSensitivePath).
//
// The credential request card in the chat UI calls apollo.set(key, value),
// which encrypts and persists immediately. The raw value is only ever held
// in memory (process.env) for the server process lifetime.
//
// This is the v0.1 secrets layer. In production at scale, swap the file
// backend for HashiCorp Vault, AWS Secrets Manager, or similar — the
// interface stays the same.
// ---------------------------------------------------------------------------

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const APOLLO_DIR = ".apollo";
const VAULT_FILE = "vault.enc";
const MASTER_KEY_FILE = "master.key";
const ALGO = "aes-256-gcm";
const SALT_FILE = "salt";
// Legacy fixed salt used before per-install salts. Retained so vaults encrypted
// before this change still decrypt: resolveSalt() falls back to it when no
// .apollo/salt file is present.
const LEGACY_SALT = "simple-harmonic-apollo-v1";
const SALT_LEN = 16;
const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

/** Resolved project root. Defaults to cwd; override for tests. */
let projectRoot = process.cwd();

/** In-memory cache of decrypted secrets. Written to process.env on load(). */
let cache: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize Apollo with a custom root (for tests or non-standard layouts).
 */
export function init(root: string): void {
  projectRoot = root;
}

/**
 * Load all secrets from the encrypted vault into process.env.
 * Call once on server startup (instrumentation.ts).
 * Safe to call multiple times; idempotent.
 */
export function load(): { count: number } {
  const masterKey = resolveMasterKey();
  if (!masterKey) return { count: 0 };

  const vaultPath = join(apolloDir(), VAULT_FILE);
  if (!existsSync(vaultPath)) return { count: 0 };

  try {
    const encrypted = readFileSync(vaultPath);
    const secrets = decrypt(encrypted, masterKey);
    cache = secrets;

    let count = 0;
    for (const [key, value] of Object.entries(secrets)) {
      // Don't overwrite explicitly set env vars (operator always wins).
      if (!process.env[key]) {
        process.env[key] = value;
        count++;
      }
    }
    return { count };
  } catch (err) {
    console.error(
      "[apollo] Failed to decrypt vault:",
      err instanceof Error ? err.message : err,
    );
    return { count: 0 };
  }
}

/**
 * Store a secret. Encrypts and persists to disk immediately, and sets
 * process.env so the value is available for the rest of this process.
 */
export function set(key: string, value: string): void {
  const masterKey = ensureMasterKey();

  // Update in-memory cache + process.env
  cache[key] = value;
  process.env[key] = value;

  // Read existing vault, merge, re-encrypt, write
  const vaultPath = join(apolloDir(), VAULT_FILE);
  let existing: Record<string, string> = {};
  if (existsSync(vaultPath)) {
    try {
      existing = decrypt(readFileSync(vaultPath), masterKey);
    } catch {
      // Corrupted vault; start fresh with current cache
      existing = {};
    }
  }

  const merged = { ...existing, ...cache };
  const encrypted = encrypt(merged, masterKey);

  mkdirSync(apolloDir(), { recursive: true });
  writeFileSync(vaultPath, encrypted);
}

/**
 * Remove a secret from the vault and process.env.
 */
export function remove(key: string): void {
  delete cache[key];
  delete process.env[key];

  const masterKey = resolveMasterKey();
  if (!masterKey) return;

  const vaultPath = join(apolloDir(), VAULT_FILE);
  if (!existsSync(vaultPath)) return;

  try {
    const existing = decrypt(readFileSync(vaultPath), masterKey);
    delete existing[key];
    writeFileSync(vaultPath, encrypt(existing, masterKey));
  } catch {
    // If vault is corrupted, removing is best-effort
  }
}

/**
 * Get a secret value from the in-memory cache. Does NOT read from disk;
 * call load() first. Returns null if not found.
 */
export function get(key: string): string | null {
  return cache[key] ?? null;
}

/**
 * List all secret keys (not values) currently in the vault.
 */
export function listKeys(): string[] {
  return Object.keys(cache);
}

/**
 * Check if a specific secret is configured (has a value).
 */
export function has(key: string): boolean {
  return key in cache || !!process.env[key];
}

/**
 * Mask a secret value for safe display (first 4 + last 4 chars).
 */
export function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 8) return "••••••••";
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

function deriveKey(masterKey: string, salt: Buffer): Buffer {
  return scryptSync(masterKey, salt, KEY_LEN);
}

function encrypt(
  data: Record<string, string>,
  masterKey: string,
): Buffer {
  const key = deriveKey(masterKey, ensureSalt());
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);

  const plaintext = JSON.stringify(data);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  // Layout: [iv (12)] [tag (16)] [ciphertext (...)]
  return Buffer.concat([iv, tag, encrypted]);
}

function decrypt(
  raw: Buffer,
  masterKey: string,
): Record<string, string> {
  if (raw.length < IV_LEN + TAG_LEN) {
    throw new Error("Vault file too short to be valid");
  }

  const key = deriveKey(masterKey, resolveSalt());
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = raw.subarray(IV_LEN + TAG_LEN);

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return JSON.parse(decrypted.toString("utf-8"));
}

// ---------------------------------------------------------------------------
// Master key management
// ---------------------------------------------------------------------------

function apolloDir(): string {
  return join(projectRoot, APOLLO_DIR);
}

/**
 * Resolve the master key. Priority:
 *   1. APOLLO_MASTER_KEY env var (for production / CI)
 *   2. .apollo/master.key file (for local dev, auto-generated)
 * Returns null if neither exists (first-time setup not triggered yet).
 */
function resolveMasterKey(): string | null {
  if (process.env.APOLLO_MASTER_KEY) {
    return process.env.APOLLO_MASTER_KEY;
  }

  const keyPath = join(apolloDir(), MASTER_KEY_FILE);
  if (existsSync(keyPath)) {
    return readFileSync(keyPath, "utf-8").trim();
  }

  return null;
}

/**
 * Ensure a master key exists. If none is set, auto-generate one and write
 * it to .apollo/master.key. This only happens once per machine.
 */
function ensureMasterKey(): string {
  const existing = resolveMasterKey();
  if (existing) return existing;

  const generated = randomBytes(32).toString("hex");
  const dir = apolloDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, MASTER_KEY_FILE), generated + "\n", {
    mode: 0o600, // owner-only read/write
  });

  console.log(
    "[apollo] Generated master key at .apollo/master.key (local-only, gitignored)",
  );
  return generated;
}

/**
 * Resolve the key-derivation salt. Returns the per-install random salt from
 * .apollo/salt if present, else the legacy fixed salt so vaults encrypted before
 * per-install salts still decrypt. Read-only (no side effects).
 */
function resolveSalt(): Buffer {
  const saltPath = join(apolloDir(), SALT_FILE);
  if (existsSync(saltPath)) {
    return readFileSync(saltPath);
  }
  return Buffer.from(LEGACY_SALT);
}

/**
 * Ensure a per-install salt exists, generating and persisting a random one on
 * first use (mode 0600). Used by the encrypt (write) path: new and rewritten
 * vaults move to a random salt, while existing legacy vaults keep decrypting via
 * resolveSalt()'s fallback until the next write migrates them.
 */
function ensureSalt(): Buffer {
  const saltPath = join(apolloDir(), SALT_FILE);
  if (existsSync(saltPath)) {
    return readFileSync(saltPath);
  }
  const salt = randomBytes(SALT_LEN);
  mkdirSync(apolloDir(), { recursive: true });
  writeFileSync(saltPath, salt, { mode: 0o600 });
  return salt;
}
