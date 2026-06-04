// ---------------------------------------------------------------------------
// Next.js instrumentation: runs once on server startup.
//
// 1. Loads Apollo secrets into process.env (encrypted at rest).
// 2. In dev mode, starts a background tick loop so agents run without a browser.
//    In production, Vercel cron handles ticking via vercel.json.
// ---------------------------------------------------------------------------

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Load encrypted secrets from .apollo/vault.enc into process.env.
    // Must run before anything reads env vars (config, connectors, tools).
    const apollo = await import("@simple-harmonic/backend/server/apollo");
    const { count } = apollo.load();
    if (count > 0) {
      console.log(`[apollo] Loaded ${count} secret(s) from vault`);
    }

    if (!process.env.VERCEL) {
      const TICK_INTERVAL_MS = 10_000;

      setInterval(async () => {
        try {
          const port = process.env.PORT || 3000;
          await fetch(`http://localhost:${port}/api/tick`, { method: "POST" });
        } catch {
          // Server not ready yet or tick failed; will retry next interval.
        }
      }, TICK_INTERVAL_MS);

      console.log(
        "[simple-harmonic] Background tick loop started (10s interval)",
      );
    }
  }
}
