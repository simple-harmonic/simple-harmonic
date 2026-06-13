// ---------------------------------------------------------------------------
// Platform status repo — a single object file (system/platform-status.json).
// Replaces the singleton platform_status table; get() returns null when unset.
// ---------------------------------------------------------------------------

import { platformStatusPath } from "../data-dir";
import { readJson, writeJson } from "../fs-store";
import { reviveDates } from "../serialize";
import type { PlatformStatus, PlatformStatusValue } from "../types";

const DATE_KEYS = ["updatedAt"] as const;

export const platformStatus = {
  async get(): Promise<PlatformStatus | null> {
    const raw = readJson<Record<string, unknown> | null>(platformStatusPath(), null);
    return raw ? (reviveDates(raw, DATE_KEYS) as unknown as PlatformStatus) : null;
  },

  async set(patch: {
    status: PlatformStatusValue;
    message: string | null;
  }): Promise<PlatformStatus> {
    const row: PlatformStatus = {
      id: 1,
      status: patch.status,
      message: patch.message,
      updatedAt: new Date(),
    };
    writeJson(platformStatusPath(), row);
    return row;
  },
};
