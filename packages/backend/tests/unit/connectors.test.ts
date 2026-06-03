import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `sh-connectors-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
  vi.stubEnv("SH_TOOLS_CWD", testDir);
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("resolveConnector", () => {
  it("resolves from secrets.json", async () => {
    const shDir = join(testDir, ".simple-harmonic");
    mkdirSync(shDir, { recursive: true });
    writeFileSync(join(shDir, "secrets.json"), JSON.stringify({ MY_TOKEN: "secret123" }));

    const { resolveConnector } = await import("@/server/connectors");
    expect(resolveConnector("MY_TOKEN")).toBe("secret123");
  });

  it("falls back to process.env", async () => {
    vi.stubEnv("FALLBACK_KEY", "from-env");
    const { resolveConnector } = await import("@/server/connectors");
    expect(resolveConnector("FALLBACK_KEY")).toBe("from-env");
  });

  it("returns null when not found anywhere", async () => {
    const { resolveConnector } = await import("@/server/connectors");
    expect(resolveConnector("DOES_NOT_EXIST_" + Date.now())).toBeNull();
  });

  it("secrets.json takes priority over env var", async () => {
    vi.stubEnv("PRIORITY_KEY", "env-value");
    const shDir = join(testDir, ".simple-harmonic");
    mkdirSync(shDir, { recursive: true });
    writeFileSync(join(shDir, "secrets.json"), JSON.stringify({ PRIORITY_KEY: "file-value" }));

    const { resolveConnector } = await import("@/server/connectors");
    expect(resolveConnector("PRIORITY_KEY")).toBe("file-value");
  });
});

describe("listConnectorMetas", () => {
  it("returns empty when no connectors directory", async () => {
    const { listConnectorMetas } = await import("@/server/connectors");
    expect(listConnectorMetas()).toEqual([]);
  });

  it("reads connector metadata files", async () => {
    const dir = join(testDir, ".simple-harmonic", "connectors");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SLACK_TOKEN.json"),
      JSON.stringify({ name: "Slack", description: "Slack bot token", type: "api_key", key: "SLACK_TOKEN" }),
    );

    const { listConnectorMetas } = await import("@/server/connectors");
    const metas = listConnectorMetas();
    expect(metas).toHaveLength(1);
    expect(metas[0].name).toBe("Slack");
    expect(metas[0].key).toBe("SLACK_TOKEN");
  });

  it("skips malformed files", async () => {
    const dir = join(testDir, ".simple-harmonic", "connectors");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "BAD.json"), "not json{{{");
    writeFileSync(
      join(dir, "GOOD.json"),
      JSON.stringify({ name: "Good", key: "GOOD", type: "api_key" }),
    );

    const { listConnectorMetas } = await import("@/server/connectors");
    const metas = listConnectorMetas();
    expect(metas).toHaveLength(1);
    expect(metas[0].key).toBe("GOOD");
  });
});

describe("saveConnector", () => {
  it("creates the connector metadata file", async () => {
    const { saveConnector } = await import("@/server/connectors");
    saveConnector({ name: "Test", description: "A test", type: "api_key", key: "TEST_KEY" });

    const file = join(testDir, ".simple-harmonic", "connectors", "TEST_KEY.json");
    expect(existsSync(file)).toBe(true);
    const meta = JSON.parse(readFileSync(file, "utf-8"));
    expect(meta.name).toBe("Test");
  });

  it("stores the secret in secrets.json", async () => {
    const { saveConnector } = await import("@/server/connectors");
    saveConnector(
      { name: "Test", description: "", type: "api_key", key: "SECRET_KEY" },
      "my-secret-value",
    );

    const secrets = JSON.parse(
      readFileSync(join(testDir, ".simple-harmonic", "secrets.json"), "utf-8"),
    );
    expect(secrets.SECRET_KEY).toBe("my-secret-value");
  });
});

describe("deleteConnectorByKey", () => {
  it("deletes the metadata file and secret", async () => {
    const { saveConnector, deleteConnectorByKey, resolveConnector } = await import("@/server/connectors");
    saveConnector(
      { name: "Del", description: "", type: "api_key", key: "DEL_KEY" },
      "to-delete",
    );
    expect(resolveConnector("DEL_KEY")).toBe("to-delete");

    const deleted = deleteConnectorByKey("DEL_KEY");
    expect(deleted).toBe(true);
    expect(resolveConnector("DEL_KEY")).toBeNull();
  });

  it("returns false for nonexistent key", async () => {
    const { deleteConnectorByKey } = await import("@/server/connectors");
    expect(deleteConnectorByKey("NOPE")).toBe(false);
  });
});
