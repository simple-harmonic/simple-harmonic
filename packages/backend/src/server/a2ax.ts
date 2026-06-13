// ---------------------------------------------------------------------------
// Singleton a2ax instance for Simple Harmonic
// ---------------------------------------------------------------------------

import { A2AX } from "@simple-harmonic/a2ax";
import { JsonFileTransport } from "@simple-harmonic/a2ax/adapters/json-file";
import { teamsRoot } from "./store/data-dir";

let instance: A2AX | null = null;

export function getA2AX(): A2AX {
  if (!instance) {
    // JsonFileTransport persists each team's messages/channels/tasks/tokens
    // under that team's folder in the data tree (<dataDir>/teams/<id>/messages).
    const transport = new JsonFileTransport(teamsRoot());

    instance = new A2AX({
      transport,
      maxContextMessages: 20,
      defaultExpiryMs: 7 * 24 * 60 * 60 * 1000,
    });
  }
  return instance;
}

/** Drop the cached instance (tests that repoint SH_DATA_DIR between cases). */
export function resetA2AXForTests(): void {
  instance = null;
}
