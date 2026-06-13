import { describe, expect, it } from "vitest";
import { getDataDir } from "@/server/store";
import { useTempStore } from "../helpers/store";

// ---------------------------------------------------------------------------
// The test-db route now round-trips a temp probe file through the configured
// data dir to confirm the file store is writable.
// ---------------------------------------------------------------------------

describe("POST /api/settings/test-db", () => {
  useTempStore();

  it("returns ok:true with the data dir when it is writable", async () => {
    const { POST } = await import("@/server/api/settings/test-db");
    const res = await POST();
    const json = (await res.json()) as { ok: boolean; dataDir?: string };

    expect(json.ok).toBe(true);
    expect(json.dataDir).toBe(getDataDir());
  });

  it("creates the data dir if it does not yet exist", async () => {
    // useTempStore points at a fresh temp dir but does not create the skeleton;
    // the route's ensureDataDir() must create it before probing.
    const { POST } = await import("@/server/api/settings/test-db");
    const res = await POST();
    const json = (await res.json()) as { ok: boolean };

    expect(json.ok).toBe(true);
  });
});
