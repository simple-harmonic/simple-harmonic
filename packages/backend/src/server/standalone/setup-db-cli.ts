// ---------------------------------------------------------------------------
// Headless data-store bootstrap — same behavior as the Settings → Storage UI
// button:
//
//   npm run data:init                 (uses the configured data dir)
//   npm run data:init -- /path/to/dir (also persists the path to
//                                      simple-harmonic.config.json)
//
// Ensures the data directory skeleton (teams/ and system/) exists. Run from the
// repo root so the config file resolves.
// ---------------------------------------------------------------------------

import { POST as setupDataDir } from "../api/settings/setup-db";
import { load as loadApolloSecrets } from "../apollo";

// Decrypt vault secrets into process.env first (same boot order as main.ts).
loadApolloSecrets();

const dataDir = process.argv[2];
const body = dataDir ? { dataDir } : {};

const response = await setupDataDir(
  new Request("http://localhost/api/settings/setup-db", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }),
);

const result = (await response.json()) as { ok?: boolean; error?: string; steps?: string[] };

for (const step of result.steps ?? []) {
  console.log(`• ${step}`);
}

if (result.ok) {
  console.log("✓ Data store ready");
  process.exit(0);
}

console.error(`✗ ${result.error ?? "setup failed"}`);
process.exit(1);
