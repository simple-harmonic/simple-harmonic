import { readFileSync } from "node:fs";
import { join } from "node:path";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../../src/server/db/schema";

// Drift guard: the drizzle schema (the source of truth) and the hand-written
// raw SQL in setup-db are two copies (drizzle-kit was removed on purpose). This
// test fails the moment a table is added to one without the other, so the
// `CREATE TABLE` SQL can't silently fall behind the schema.
describe("schema drift guard (drizzle schema vs setup-db SQL)", () => {
  const routePath = join(
    __dirname,
    "../../../../src/app/api/settings/setup-db/route.ts",
  );
  const sql = readFileSync(routePath, "utf8");
  const sqlTables = new Set(
    [...sql.matchAll(/CREATE TABLE IF NOT EXISTS "([a-z0-9_]+)"/g)].map(
      (m) => m[1],
    ),
  );

  const drizzleTables = Object.values(schema)
    .filter((v) => is(v, PgTable))
    .map((t) => getTableConfig(t as PgTable).name);

  it("every drizzle table has a matching CREATE TABLE in setup-db SQL", () => {
    const missing = drizzleTables.filter((t) => !sqlTables.has(t));
    expect(missing).toEqual([]);
  });

  it("discovers a sane number of tables (guards a broken matcher)", () => {
    expect(drizzleTables.length).toBeGreaterThanOrEqual(10);
    expect(sqlTables.size).toBeGreaterThanOrEqual(10);
  });
});
