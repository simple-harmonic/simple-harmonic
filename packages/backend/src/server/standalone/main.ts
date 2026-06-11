// ---------------------------------------------------------------------------
// Standalone backend entrypoint — runs the whole agent platform without the
// Next.js frontend:
//
//   npm run dev:backend          (from the repo root)
//
// Boot order mirrors src/instrumentation.ts:
//   1. apollo.load() decrypts .apollo/vault.enc into process.env.
//   2. The HTTP server exposes the same /api/* surface as the Next app.
//   3. A background tick loop drives agents every 10s (SH_TICK_LOOP=0 disables
//      it, e.g. when an external cron POSTs /api/tick instead).
//
// Run from the repo root: simple-harmonic.config.json and .apollo/ are
// resolved from process.cwd().
// ---------------------------------------------------------------------------

import { POST as tick } from "../api/tick";
import { load as loadApolloSecrets } from "../apollo";
import { getConfig } from "../config";
import { isProductionRuntime } from "../operator-auth";
import { createBackendServer } from "./server";

const TICK_INTERVAL_MS = 10_000;

function redactedDbHost(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    return `${url.host}${url.pathname}`;
  } catch {
    return "(invalid database URL)";
  }
}

const port = Number(process.env.SH_BACKEND_PORT || process.env.PORT || 3001);

const { count } = loadApolloSecrets();
if (count > 0) {
  console.log(`[apollo] Loaded ${count} secret(s) from vault`);
}

const config = getConfig();
console.log(
  `[simple-harmonic] cwd=${process.cwd()} model=${config.model} ` +
    `codingBackend=${config.codingBackend} db=${redactedDbHost(config.databaseUrl)}`,
);

const server = createBackendServer();
server.listen(port, () => {
  console.log(`[simple-harmonic] backend listening on http://localhost:${port}`);
});

if (process.env.SH_TICK_LOOP === "0") {
  console.log("[simple-harmonic] Tick loop disabled (SH_TICK_LOOP=0)");
} else if (isProductionRuntime() && !process.env.CRON_SECRET) {
  // The tick endpoint fails closed in production without CRON_SECRET, so the
  // loop would 401 against its own server every 10s. Fail loudly instead.
  console.error(
    "[simple-harmonic] Tick loop NOT started: production requires CRON_SECRET " +
      "(the loop authenticates with it). Set CRON_SECRET, or set SH_TICK_LOOP=0 " +
      "and POST /api/tick from an external cron.",
  );
} else {
  setInterval(async () => {
    try {
      const headers: Record<string, string> = {};
      if (process.env.CRON_SECRET) {
        headers.authorization = `Bearer ${process.env.CRON_SECRET}`;
      }
      const res = await tick(
        new Request(`http://localhost:${port}/api/tick`, { method: "POST", headers }),
      );
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        console.error(`[tick] HTTP ${res.status}: ${detail}`);
      }
    } catch (err) {
      console.error("[tick] failed:", err);
    }
  }, TICK_INTERVAL_MS);
  console.log("[simple-harmonic] Background tick loop started (10s interval)");
}
