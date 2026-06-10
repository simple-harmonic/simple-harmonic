import { readFileSync } from "node:fs";
import { join } from "node:path";
import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "../../src/server/db/schema";

// Drift guard: the drizzle schema (the source of truth) and the hand-written
// raw SQL in setup-db are two copies (drizzle-kit was removed on purpose).
// Table-name parity alone is not enough — a column or index added to one side
// but not the other ships a DB that the code can't query ("Failed query" tick
// errors on stale DBs). So this guard compares, per table:
//   - column names (CREATE TABLE plus the ALTER TABLE ADD COLUMN section)
//   - column SQL types (drizzle's getSQLType() vs the SQL token)
//   - NOT NULL-ness (PRIMARY KEY implies NOT NULL)
//   - index names and their column lists
//   - enum names and their value lists
// Defaults and foreign keys stay out of scope: defaults are cosmetic for
// drift purposes, and the SQL intentionally carries ON DELETE behavior the
// drizzle schema doesn't model.

const routePath = join(__dirname, "../../../../src/app/api/settings/setup-db/route.ts");
const sqlText = readFileSync(routePath, "utf8");

// ---------------------------------------------------------------------------
// Parse the hand-written SQL
// ---------------------------------------------------------------------------

interface SqlColumn {
  type: string;
  notNull: boolean;
}

function normalizeType(t: string): string {
  return t.replace(/"/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Columns per table from CREATE TABLE blocks. */
function parseCreateTables(sql: string): Map<string, Map<string, SqlColumn>> {
  const tables = new Map<string, Map<string, SqlColumn>>();
  const blockRe = /CREATE TABLE IF NOT EXISTS "([a-z0-9_]+)" \(([\s\S]*?)\n\);/g;
  for (const m of sql.matchAll(blockRe)) {
    const [, tableName, body] = m;
    const cols = new Map<string, SqlColumn>();
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim().replace(/,$/, "");
      if (!line || line.startsWith("--")) continue;
      const colMatch = line.match(/^"([a-z0-9_]+)"\s+(.*)$/);
      if (!colMatch) continue; // constraint lines (PRIMARY KEY (...), etc.)
      const [, colName, rest] = colMatch;
      // Type = everything before the first constraint keyword.
      const typePart = rest.split(
        /\s+(?:PRIMARY KEY|NOT NULL|DEFAULT|REFERENCES|UNIQUE|CHECK)\b/,
      )[0];
      cols.set(colName, {
        type: normalizeType(typePart),
        notNull: /\bNOT NULL\b/.test(rest) || /\bPRIMARY KEY\b/.test(rest),
      });
    }
    tables.set(tableName, cols);
  }
  return tables;
}

/** Columns added by the back-compat ALTER TABLE ADD COLUMN section. */
function parseAlterAdds(sql: string): Map<string, Map<string, SqlColumn>> {
  const adds = new Map<string, Map<string, SqlColumn>>();
  const re = /ALTER TABLE "([a-z0-9_]+)" ADD COLUMN IF NOT EXISTS "([a-z0-9_]+)"\s+([^;]+);/g;
  for (const m of sql.matchAll(re)) {
    const [, tableName, colName, rest] = m;
    const typePart = rest.split(
      /\s+(?:PRIMARY KEY|NOT NULL|DEFAULT|REFERENCES|UNIQUE|CHECK)\b/,
    )[0];
    const cols = adds.get(tableName) ?? new Map<string, SqlColumn>();
    cols.set(colName, {
      type: normalizeType(typePart),
      notNull: /\bNOT NULL\b/.test(rest),
    });
    adds.set(tableName, cols);
  }
  return adds;
}

/** CREATE INDEX name → { table, columns }. */
function parseIndexes(sql: string): Map<string, { table: string; columns: string[] }> {
  const out = new Map<string, { table: string; columns: string[] }>();
  const re = /CREATE INDEX IF NOT EXISTS "([a-z0-9_]+)" ON "([a-z0-9_]+)" \(([^)]+)\)/g;
  for (const m of sql.matchAll(re)) {
    const [, name, table, colList] = m;
    out.set(name, {
      table,
      columns: colList.split(",").map((c) => c.trim().replace(/"/g, "")),
    });
  }
  return out;
}

/** CREATE TYPE name → enum values. */
function parseEnums(sql: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const re = /CREATE TYPE "([a-z0-9_]+)" AS ENUM \(([^)]+)\)/g;
  for (const m of sql.matchAll(re)) {
    const [, name, valueList] = m;
    out.set(
      name,
      valueList.split(",").map((v) => v.trim().replace(/'/g, "")),
    );
  }
  return out;
}

const sqlTables = parseCreateTables(sqlText);
const sqlAlterAdds = parseAlterAdds(sqlText);
const sqlIndexes = parseIndexes(sqlText);
const sqlEnums = parseEnums(sqlText);

/** Effective SQL columns: CREATE TABLE ∪ ALTER ADD (what setup-db produces). */
function effectiveSqlColumns(tableName: string): Map<string, SqlColumn> {
  const merged = new Map(sqlTables.get(tableName) ?? []);
  for (const [name, col] of sqlAlterAdds.get(tableName) ?? []) {
    if (!merged.has(name)) merged.set(name, col);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Drizzle side
// ---------------------------------------------------------------------------

const drizzleTables = Object.values(schema)
  .filter((v) => is(v, PgTable))
  .map((t) => getTableConfig(t as PgTable));

interface DrizzleEnumLike {
  enumName: string;
  enumValues: string[];
}

const drizzleEnums = Object.values(schema).filter(
  (v): v is DrizzleEnumLike =>
    typeof v === "function" && "enumName" in v && "enumValues" in v,
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("schema drift guard (drizzle schema vs setup-db SQL)", () => {
  it("every drizzle table has a matching CREATE TABLE in setup-db SQL", () => {
    const missing = drizzleTables.map((t) => t.name).filter((t) => !sqlTables.has(t));
    expect(missing).toEqual([]);
  });

  it("every CREATE TABLE in setup-db SQL has a matching drizzle table", () => {
    const drizzleNames = new Set(drizzleTables.map((t) => t.name));
    const extra = [...sqlTables.keys()].filter((t) => !drizzleNames.has(t));
    expect(extra).toEqual([]);
  });

  it("discovers a sane number of tables (guards a broken matcher)", () => {
    expect(drizzleTables.length).toBeGreaterThanOrEqual(10);
    expect(sqlTables.size).toBeGreaterThanOrEqual(10);
  });

  it("every column matches by name, SQL type, and NOT NULL-ness", () => {
    const problems: string[] = [];
    for (const table of drizzleTables) {
      const sqlCols = effectiveSqlColumns(table.name);
      const drizzleColNames = new Set<string>();

      for (const col of table.columns) {
        drizzleColNames.add(col.name);
        const sqlCol = sqlCols.get(col.name);
        if (!sqlCol) {
          problems.push(`${table.name}.${col.name}: missing from setup-db SQL`);
          continue;
        }
        const expectedType = normalizeType(col.getSQLType());
        if (sqlCol.type !== expectedType) {
          problems.push(
            `${table.name}.${col.name}: type "${sqlCol.type}" in SQL, "${expectedType}" in schema.ts`,
          );
        }
        if (sqlCol.notNull !== col.notNull) {
          problems.push(
            `${table.name}.${col.name}: NOT NULL is ${sqlCol.notNull} in SQL, ${col.notNull} in schema.ts`,
          );
        }
      }

      for (const sqlColName of sqlCols.keys()) {
        if (!drizzleColNames.has(sqlColName)) {
          problems.push(`${table.name}.${sqlColName}: in setup-db SQL but not in schema.ts`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("every index matches by name, table, and column list", () => {
    const problems: string[] = [];
    const drizzleIndexNames = new Set<string>();

    for (const table of drizzleTables) {
      for (const idx of table.indexes) {
        const name = idx.config.name;
        if (!name) {
          problems.push(`${table.name}: index without an explicit name`);
          continue;
        }
        drizzleIndexNames.add(name);
        const sqlIdx = sqlIndexes.get(name);
        if (!sqlIdx) {
          problems.push(`index ${name} (on ${table.name}): missing from setup-db SQL`);
          continue;
        }
        if (sqlIdx.table !== table.name) {
          problems.push(`index ${name}: on "${sqlIdx.table}" in SQL, "${table.name}" in schema.ts`);
        }
        const drizzleCols = idx.config.columns.map((c) =>
          String((c as { name?: string }).name ?? c),
        );
        expect(drizzleCols.every((c) => typeof c === "string" && c.length > 0)).toBe(true);
        if (JSON.stringify(drizzleCols) !== JSON.stringify(sqlIdx.columns)) {
          problems.push(
            `index ${name}: columns (${sqlIdx.columns.join(", ")}) in SQL, (${drizzleCols.join(", ")}) in schema.ts`,
          );
        }
      }
    }

    for (const name of sqlIndexes.keys()) {
      if (!drizzleIndexNames.has(name)) {
        problems.push(`index ${name}: in setup-db SQL but not in schema.ts`);
      }
    }
    expect(problems).toEqual([]);
  });

  it("every enum matches by name and value list", () => {
    const problems: string[] = [];
    const drizzleEnumNames = new Set<string>();

    for (const e of drizzleEnums) {
      drizzleEnumNames.add(e.enumName);
      const sqlValues = sqlEnums.get(e.enumName);
      if (!sqlValues) {
        problems.push(`enum ${e.enumName}: missing from setup-db SQL`);
        continue;
      }
      if (JSON.stringify(sqlValues) !== JSON.stringify(e.enumValues)) {
        problems.push(
          `enum ${e.enumName}: values (${sqlValues.join(", ")}) in SQL, (${e.enumValues.join(", ")}) in schema.ts`,
        );
      }
    }

    for (const name of sqlEnums.keys()) {
      if (!drizzleEnumNames.has(name)) {
        problems.push(`enum ${name}: in setup-db SQL but not in schema.ts`);
      }
    }

    expect(drizzleEnums.length).toBeGreaterThanOrEqual(5); // guards a broken filter
    expect(problems).toEqual([]);
  });
});
