// ---------------------------------------------------------------------------
// Test helper: point the JSON file store at a fresh temp directory per test.
//
// The file store is synchronous local IO, so tests run against the REAL store
// (seed via repos, call the route, assert on the response or the resulting
// files) instead of mocking a query builder. Call useTempStore() at the top of
// a describe/file; it registers beforeEach/afterEach to create and tear down an
// isolated data dir and reset the store + a2ax singleton between cases.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { resetA2AXForTests } from "@/server/a2ax";
import { resetStore, setDataDir } from "@/server/store";

let currentDir: string | null = null;

/** Register per-test temp-store lifecycle. Returns an accessor for the dir. */
export function useTempStore(): { dir: () => string } {
  beforeEach(() => {
    currentDir = mkdtempSync(join(tmpdir(), "sh-store-"));
    setDataDir(currentDir);
    resetStore();
    resetA2AXForTests();
  });

  afterEach(() => {
    if (currentDir) rmSync(currentDir, { recursive: true, force: true });
    setDataDir(null);
    resetStore();
    resetA2AXForTests();
    currentDir = null;
  });

  return { dir: () => currentDir as string };
}
