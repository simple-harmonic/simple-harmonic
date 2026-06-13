// ---------------------------------------------------------------------------
// Initialize the JSON file store. Formerly created a Postgres database and
// pushed the schema; now it just ensures the data directory skeleton exists
// (teams/ and system/). Optionally persists a custom dataDir to the config so
// the UI/CLI can point the store somewhere else.
//
// Kept at the /api/settings/setup-db route so the Settings UI button and the
// `data:init` CLI continue to work without churn.
// ---------------------------------------------------------------------------

import { setConfig } from "../../config";
import { ensureDataDir } from "../../store";

export async function POST(request: Request) {
  const steps: string[] = [];
  try {
    const body = (await request.json().catch(() => ({}))) as { dataDir?: string };

    if (typeof body.dataDir === "string" && body.dataDir.trim().length > 0) {
      setConfig({ dataDir: body.dataDir.trim() });
      steps.push(`Set data directory to ${body.dataDir.trim()}`);
    }

    const dir = ensureDataDir();
    steps.push(`Data directory ready: ${dir}`);

    return Response.json({ ok: true, steps });
  } catch (err) {
    return Response.json({
      ok: false,
      steps,
      error: err instanceof Error ? err.message : "setup failed",
    });
  }
}
