// ---------------------------------------------------------------------------
// Verify the data directory is writable. Formerly tested a Postgres connection;
// now it round-trips a temp file through the configured data dir so the Settings
// UI can confirm the file store is usable.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDataDir } from "../../store";

export async function POST() {
  try {
    const dir = ensureDataDir();
    const probe = join(dir, `.write-test-${randomUUID()}`);
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return Response.json({ ok: true, dataDir: dir });
  } catch (err) {
    return Response.json({
      ok: false,
      error: err instanceof Error ? err.message : "Data directory not writable",
    });
  }
}
