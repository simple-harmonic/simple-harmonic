// ---------------------------------------------------------------------------
// Headless DB bootstrap — same behavior as the Settings → Database UI button:
//
//   npm run db:setup                          (uses config/env database URL)
//   npm run db:setup -- postgresql://...      (also persists the URL to
//                                              simple-harmonic.config.json)
//
// Creates the database if missing, applies the idempotent SCHEMA_SQL, and
// verifies the tables. Run from the repo root so the config file resolves.
// ---------------------------------------------------------------------------

import { POST as setupDb } from "../api/settings/setup-db";
import { load as loadApolloSecrets } from "../apollo";

// Decrypt vault secrets into process.env first — a vault-stored DATABASE_URL
// must be visible to getConfig() (same boot order as main.ts).
loadApolloSecrets();

const databaseUrl = process.argv[2];
const body = databaseUrl ? { databaseUrl } : {};

const response = await setupDb(
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
  console.log("✓ Database ready");
  process.exit(0);
}

console.error(`✗ ${result.error ?? "setup failed"}`);
process.exit(1);
