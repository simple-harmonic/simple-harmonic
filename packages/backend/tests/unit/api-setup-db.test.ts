import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getDataDir, setDataDir } from "@/server/store";
import { systemDir, teamsRoot } from "@/server/store/data-dir";
import { useTempStore } from "../helpers/store";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRequest(body: Record<string, unknown> | null = {}): Request {
  return new Request("http://localhost/api/settings/setup-db", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === null ? undefined : JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/settings/setup-db", () => {
  useTempStore();

  it("ensures the data dir skeleton and returns ok with steps", async () => {
    const { POST } = await import("@/server/api/settings/setup-db");
    const res = await POST(makeRequest({}));
    const body = (await res.json()) as { ok: boolean; steps?: string[] };

    expect(body.ok).toBe(true);
    expect(Array.isArray(body.steps)).toBe(true);
    expect(body.steps?.some((s) => s.includes("Data directory ready"))).toBe(true);

    // The route creates the teams/ and system/ roots under the data dir.
    expect(existsSync(teamsRoot())).toBe(true);
    expect(existsSync(systemDir())).toBe(true);
    expect(body.steps?.some((s) => s.includes(getDataDir()))).toBe(true);
  });

  it("handles a missing/empty request body", async () => {
    const { POST } = await import("@/server/api/settings/setup-db");
    const res = await POST(makeRequest(null));
    const body = (await res.json()) as { ok: boolean; steps?: string[] };

    expect(body.ok).toBe(true);
    expect(existsSync(teamsRoot())).toBe(true);
  });

  it("does not include a 'set data directory' step when no dataDir provided", async () => {
    const { POST } = await import("@/server/api/settings/setup-db");
    const res = await POST(makeRequest({}));
    const body = (await res.json()) as { ok: boolean; steps?: string[] };

    expect(body.ok).toBe(true);
    expect(body.steps?.some((s) => s.startsWith("Set data directory"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Persisting a custom dataDir writes to the real config file, so isolate that
// case with its own temp dir + cwd-scoped config cleanup.
// ---------------------------------------------------------------------------

describe("POST /api/settings/setup-db with a custom dataDir", () => {
  let tempDir: string | null = null;
  const configPath = join(process.cwd(), "simple-harmonic.config.json");
  const hadConfig = existsSync(configPath);

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
    setDataDir(null);
    // Clean up the config file the route wrote, unless one pre-existed.
    if (!hadConfig && existsSync(configPath)) {
      rmSync(configPath, { force: true });
    }
  });

  it("persists the provided dataDir and creates the skeleton there", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "sh-setup-db-"));
    const target = join(tempDir, "store");

    const { POST } = await import("@/server/api/settings/setup-db");
    const res = await POST(makeRequest({ dataDir: target }));
    const body = (await res.json()) as { ok: boolean; steps?: string[] };

    expect(body.ok).toBe(true);
    expect(body.steps?.some((s) => s.includes(`Set data directory to ${target}`))).toBe(true);

    // The skeleton was created under the provided dataDir.
    expect(existsSync(join(target, "teams"))).toBe(true);
    expect(existsSync(join(target, "system"))).toBe(true);

    // And the dataDir was persisted to the config file.
    const written = JSON.parse(readFileSync(configPath, "utf-8")) as { dataDir?: string };
    expect(written.dataDir).toBe(target);
  });
});
