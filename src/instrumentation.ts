// ---------------------------------------------------------------------------
// Next.js instrumentation: runs once on server startup.
// In dev mode, starts a background tick loop so agents run without a browser.
// In production, Vercel cron handles ticking via vercel.json.
// ---------------------------------------------------------------------------

import { eq } from "drizzle-orm";
import { db } from "@simple-harmonic/backend/server/db";
import { agents } from "@simple-harmonic/backend/server/db/schema";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Reset any agents stuck in-flight from a previous crash / restart.
    // Without this, agents whose tick was killed mid-execution stay
    // permanently stuck with inFlight=true.
    try {
      const d = db();
      await d
        .update(agents)
        .set({ inFlight: false })
        .where(eq(agents.inFlight, true));
      console.log("[simple-harmonic] Reset stale in-flight agents");
    } catch {
      // DB not ready yet, will self-heal via auto-recovery
    }

    // Only start the background tick loop in dev. On Vercel, the cron in
    // vercel.json handles ticking; running both would multiply agent runs
    // and API costs.
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

      console.log("[simple-harmonic] Background tick loop started (10s interval)");
    }
  }
}
