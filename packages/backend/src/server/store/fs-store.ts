// ---------------------------------------------------------------------------
// Low-level filesystem primitives for the JSON store.
//
// All IO is SYNCHRONOUS. Node is single-threaded, the files are small and
// local, and a synchronous read-modify-write runs to completion before any
// other event-loop task — so concurrent agent runs (Promise.allSettled in the
// tick loop) can't interleave a mutation and there is no write queue to manage.
// JSON objects/arrays are written atomically (temp file + rename) so a crash
// mid-write can't corrupt them; JSONL logs are appended (one atomic append per
// line). Repos wrap these in async functions so existing `await repo.x()` call
// sites are unchanged.
// ---------------------------------------------------------------------------

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function pathExists(p: string): boolean {
  return existsSync(p);
}

/** Read+parse a JSON file. Missing or empty file → fallback. Corrupt → throws. */
export function readJson<T>(path: string, fallback: T): T {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
  if (raw.trim() === "") return fallback;
  return JSON.parse(raw) as T;
}

/** Atomically write a pretty-printed JSON file (temp + rename). */
export function writeJson(path: string, value: unknown): void {
  ensureDir(path);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, path);
}

/** Read → mutate → write a JSON file atomically. Returns the written value. */
export function updateJson<T>(path: string, fallback: T, mutate: (cur: T) => T): T {
  const next = mutate(readJson(path, fallback));
  writeJson(path, next);
  return next;
}

/** Read a JSONL file into an array. Missing → []. Blank lines skipped. */
export function readJsonl<T>(path: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    out.push(JSON.parse(line) as T);
  }
  return out;
}

/** Append one row to a JSONL file. */
export function appendJsonl(path: string, row: unknown): void {
  ensureDir(path);
  appendFileSync(path, `${JSON.stringify(row)}\n`);
}

/** Append many rows to a JSONL file in one write. */
export function appendJsonlMany(path: string, rows: unknown[]): void {
  if (rows.length === 0) return;
  ensureDir(path);
  appendFileSync(path, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

/** Atomically rewrite a JSONL file (used by retention/prune). */
export function rewriteJsonl(path: string, rows: unknown[]): void {
  ensureDir(path);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, rows.length === 0 ? "" : `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  renameSync(tmp, path);
}

/** Remove a file or directory subtree if it exists (cascade-delete a folder). */
export function removePath(p: string): void {
  rmSync(p, { recursive: true, force: true });
}

/** Move a file or directory subtree to a new path (creates the parent). */
export function movePath(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
}

/** Names of immediate sub-directories (not files). Missing parent → []. */
export function listSubdirs(dir: string): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/** Names of immediate files (not directories). Missing parent → []. */
export function listFiles(dir: string): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries.filter((e) => e.isFile()).map((e) => e.name);
}
