import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { scryptSync, createCipheriv, randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as apollo from "../../src/server/apollo";

describe("Apollo secrets manager", () => {
  let tempDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "apollo-test-"));
    apollo.init(tempDir);
    // Save and clear env vars we'll use
    for (const key of ["APOLLO_MASTER_KEY", "TEST_SECRET_1", "TEST_SECRET_2"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    // Restore env vars
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("auto-generates master key on first set()", () => {
    apollo.set("TEST_SECRET_1", "value1");

    const keyPath = join(tempDir, ".apollo", "master.key");
    expect(existsSync(keyPath)).toBe(true);
    const key = readFileSync(keyPath, "utf-8").trim();
    expect(key.length).toBe(64); // 32 bytes hex
  });

  it("encrypts vault file on disk (not plaintext)", () => {
    apollo.set("TEST_SECRET_1", "my-secret-token");

    const vaultPath = join(tempDir, ".apollo", "vault.enc");
    expect(existsSync(vaultPath)).toBe(true);
    const raw = readFileSync(vaultPath, "utf-8");
    expect(raw).not.toContain("my-secret-token");
    expect(raw).not.toContain("TEST_SECRET_1");
  });

  it("set() makes the value available in process.env", () => {
    apollo.set("TEST_SECRET_1", "val123");
    expect(process.env.TEST_SECRET_1).toBe("val123");
  });

  it("load() decrypts secrets into process.env", () => {
    // Write a secret
    apollo.set("TEST_SECRET_1", "alpha");
    apollo.set("TEST_SECRET_2", "beta");

    // Clear process.env to simulate a restart
    delete process.env.TEST_SECRET_1;
    delete process.env.TEST_SECRET_2;

    // Re-init and load
    apollo.init(tempDir);
    const { count } = apollo.load();

    expect(count).toBe(2);
    expect(process.env.TEST_SECRET_1).toBe("alpha");
    expect(process.env.TEST_SECRET_2).toBe("beta");
  });

  it("load() does not overwrite explicitly set env vars", () => {
    apollo.set("TEST_SECRET_1", "from-vault");

    // Simulate operator setting the var explicitly
    process.env.TEST_SECRET_1 = "from-operator";

    apollo.init(tempDir);
    apollo.load();

    // Operator wins
    expect(process.env.TEST_SECRET_1).toBe("from-operator");
  });

  it("remove() deletes from vault and process.env", () => {
    apollo.set("TEST_SECRET_1", "to-remove");
    expect(process.env.TEST_SECRET_1).toBe("to-remove");

    apollo.remove("TEST_SECRET_1");
    expect(process.env.TEST_SECRET_1).toBeUndefined();

    // Verify it's gone from the vault too
    delete process.env.TEST_SECRET_1;
    apollo.init(tempDir);
    apollo.load();
    expect(process.env.TEST_SECRET_1).toBeUndefined();
  });

  it("get() returns cached value", () => {
    apollo.set("TEST_SECRET_1", "cached-val");
    expect(apollo.get("TEST_SECRET_1")).toBe("cached-val");
    expect(apollo.get("NONEXISTENT")).toBeNull();
  });

  it("has() checks availability", () => {
    apollo.set("TEST_SECRET_1", "exists");
    expect(apollo.has("TEST_SECRET_1")).toBe(true);
    expect(apollo.has("NONEXISTENT")).toBe(false);
  });

  it("listKeys() returns all secret keys", () => {
    apollo.set("TEST_SECRET_1", "a");
    apollo.set("TEST_SECRET_2", "b");
    const keys = apollo.listKeys();
    expect(keys).toContain("TEST_SECRET_1");
    expect(keys).toContain("TEST_SECRET_2");
  });

  it("mask() hides the middle of a secret", () => {
    expect(apollo.mask("ghp_abc123xyz789")).toBe("ghp_••••z789");
    expect(apollo.mask("short")).toBe("••••••••");
    expect(apollo.mask("")).toBe("");
  });

  it("uses APOLLO_MASTER_KEY env var when set", () => {
    process.env.APOLLO_MASTER_KEY = "custom-master-key-for-test";
    apollo.set("TEST_SECRET_1", "with-custom-key");

    // Master key file should NOT be created when env var is set
    const keyPath = join(tempDir, ".apollo", "master.key");
    expect(existsSync(keyPath)).toBe(false);

    // Secret should still work
    expect(process.env.TEST_SECRET_1).toBe("with-custom-key");
  });

  it("load() returns count 0 when no vault exists", () => {
    const { count } = apollo.load();
    expect(count).toBe(0);
  });

  it("creates a per-install salt file on set()", () => {
    apollo.set("TEST_SECRET_1", "value1");
    expect(existsSync(join(tempDir, ".apollo", "salt"))).toBe(true);
  });

  it("two installs with the same master key generate different salts", () => {
    process.env.APOLLO_MASTER_KEY = "shared-master-key";
    const dirA = mkdtempSync(join(tmpdir(), "apollo-a-"));
    const dirB = mkdtempSync(join(tmpdir(), "apollo-b-"));
    apollo.init(dirA);
    apollo.set("TEST_SECRET_1", "same-value");
    apollo.init(dirB);
    apollo.set("TEST_SECRET_1", "same-value");
    const saltA = readFileSync(join(dirA, ".apollo", "salt"));
    const saltB = readFileSync(join(dirB, ".apollo", "salt"));
    expect(Buffer.compare(saltA, saltB)).not.toBe(0);
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  it("decrypts a legacy vault (no salt file) via the legacy fallback", () => {
    process.env.APOLLO_MASTER_KEY = "legacy-master-key";
    const dir = mkdtempSync(join(tmpdir(), "apollo-legacy-"));
    // Hand-roll a pre-migration vault: AES-256-GCM keyed by
    // scrypt(masterKey, LEGACY_SALT), layout [iv(12)][tag(16)][ciphertext],
    // and crucially NO .apollo/salt file (simulates an old install).
    const key = scryptSync("legacy-master-key", "simple-harmonic-apollo-v1", 32);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([
      cipher.update(JSON.stringify({ LEGACY_KEY: "legacy-val" }), "utf-8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    mkdirSync(join(dir, ".apollo"), { recursive: true });
    writeFileSync(join(dir, ".apollo", "vault.enc"), Buffer.concat([iv, tag, ct]));
    expect(existsSync(join(dir, ".apollo", "salt"))).toBe(false);

    apollo.init(dir);
    const { count } = apollo.load();
    expect(count).toBe(1);
    expect(process.env.LEGACY_KEY).toBe("legacy-val");

    delete process.env.LEGACY_KEY;
    rmSync(dir, { recursive: true, force: true });
  });
});
