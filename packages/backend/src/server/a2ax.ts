// ---------------------------------------------------------------------------
// Singleton a2ax instance for Simple Harmonic
// ---------------------------------------------------------------------------

import { A2AX } from "@simple-harmonic/a2ax";
import { DrizzleTransport } from "@simple-harmonic/a2ax/adapters/drizzle";
import { db } from "./db";

let instance: A2AX | null = null;

export function getA2AX(): A2AX {
  if (!instance) {
    // DrizzleTransport needs a PgDatabase-compatible instance.
    // Simple Harmonic's db() returns NodePgDatabase which satisfies PgDatabase<any>.
    const transport = new DrizzleTransport(db() as any);

    instance = new A2AX({
      transport,
      maxContextMessages: 20,
      defaultExpiryMs: 7 * 24 * 60 * 60 * 1000,
    });
  }
  return instance;
}
