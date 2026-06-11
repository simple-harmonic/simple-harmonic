#!/usr/bin/env python3
"""Diff a live Postgres database against the code's schema.

The vitest drift guard (packages/backend/tests/unit/schema-sync.test.ts)
keeps the setup-db SQL in lockstep with the drizzle schema, so this script
only has to compare the live catalog against that SQL — transitively, the
live DB against the code. Checks tables, columns (name/type/not-null),
indexes, and enums. Foreign keys and defaults are intentionally out of scope.

Usage:
    scripts/db-code-diff.py [database-url-or-name]

Without an argument, reads databaseUrl from ./simple-harmonic.config.json.
Exits 1 with a mismatch list if the live DB has drifted; re-running the
setup-db route (Settings → database setup) is the usual fix.
"""

import json
import os
import re
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL_PATH = os.path.join(REPO_ROOT, "packages/backend/src/server/api/settings/setup-db.ts")


def resolve_target() -> str:
    if len(sys.argv) > 1:
        return sys.argv[1]
    config_path = os.path.join(os.getcwd(), "simple-harmonic.config.json")
    try:
        with open(config_path) as f:
            url = json.load(f).get("databaseUrl", "")
        if url:
            return url
    except FileNotFoundError:
        pass
    sys.exit("usage: db-code-diff.py <database-url-or-name> (no databaseUrl in config)")


def psql(target: str, query: str) -> list[list[str]]:
    out = subprocess.run(
        ["psql", target, "-tA", "-F", "\t", "-c", query],
        capture_output=True, text=True, check=True,
    ).stdout
    return [line.split("\t") for line in out.strip().split("\n") if line]


TYPE_SPLIT = re.compile(r"\s+(?:PRIMARY KEY|NOT NULL|DEFAULT|REFERENCES|UNIQUE|CHECK)\b")


def norm(t: str) -> str:
    return re.sub(r"\s+", " ", t.replace('"', "")).strip().lower()


def parse_sql(sql_text: str):
    tables: dict[str, dict[str, dict]] = {}
    for m in re.finditer(r'CREATE TABLE IF NOT EXISTS "([a-z0-9_]+)" \(([\s\S]*?)\n\);', sql_text):
        name, body = m.group(1), m.group(2)
        cols = {}
        for raw in body.split("\n"):
            line = raw.strip().rstrip(",")
            if not line or line.startswith("--"):
                continue
            cm = re.match(r'^"([a-z0-9_]+)"\s+(.*)$', line)
            if not cm:
                continue
            rest = cm.group(2)
            cols[cm.group(1)] = {
                "type": norm(TYPE_SPLIT.split(rest)[0]),
                "notnull": bool(re.search(r"\bNOT NULL\b|\bPRIMARY KEY\b", rest)),
            }
        tables[name] = cols

    for m in re.finditer(
        r'ALTER TABLE "([a-z0-9_]+)" ADD COLUMN IF NOT EXISTS "([a-z0-9_]+)"\s+([^;]+);', sql_text
    ):
        t, c, rest = m.group(1), m.group(2), m.group(3)
        tables.setdefault(t, {}).setdefault(c, {
            "type": norm(TYPE_SPLIT.split(rest)[0]),
            "notnull": bool(re.search(r"\bNOT NULL\b", rest)),
        })

    indexes = {
        m.group(1): (m.group(2), [c.strip().strip('"') for c in m.group(3).split(",")])
        for m in re.finditer(
            r'CREATE INDEX IF NOT EXISTS "([a-z0-9_]+)" ON "([a-z0-9_]+)" \(([^)]+)\)', sql_text
        )
    }
    enums = {
        m.group(1): [v.strip().strip("'") for v in m.group(2).split(",")]
        for m in re.finditer(r'CREATE TYPE "([a-z0-9_]+)" AS ENUM \(([^)]+)\)', sql_text)
    }
    return tables, indexes, enums


def type_matches(sql_type: str, live: dict) -> bool:
    expected = {
        "uuid": ("uuid", "uuid"),
        "text": ("text", "text"),
        "jsonb": ("jsonb", "jsonb"),
        "integer": ("integer", "int4"),
        "boolean": ("boolean", "bool"),
        "timestamp with time zone": ("timestamp with time zone", "timestamptz"),
    }
    if sql_type in expected:
        dt, udt = expected[sql_type]
        return live["data_type"] == dt or live["udt"] == udt
    return live["data_type"] == "user-defined" and live["udt"] == sql_type


def main() -> None:
    target = resolve_target()
    with open(SQL_PATH) as f:
        sql_tables, sql_indexes, sql_enums = parse_sql(f.read())
    # Mirrors the schema-sync test's sanity floor: a near-empty parse means the
    # setup-db SQL moved or changed shape, not that the schema shrank.
    if len(sql_tables) < 10:
        sys.exit(
            f"parsed only {len(sql_tables)} tables from {SQL_PATH}; "
            "the setup-db SQL likely moved — update SQL_PATH"
        )

    live_cols: dict[str, dict[str, dict]] = {}
    for table, col, data_type, udt, nullable in psql(
        target,
        "SELECT table_name, column_name, data_type, udt_name, is_nullable "
        "FROM information_schema.columns WHERE table_schema='public' "
        "ORDER BY table_name, ordinal_position",
    ):
        live_cols.setdefault(table, {})[col] = {
            "data_type": data_type.lower(),
            "udt": udt,
            "notnull": nullable == "NO",
        }

    live_indexes: dict[str, tuple[str, list[str]]] = {}
    for name, table, definition in psql(
        target, "SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname='public'"
    ):
        cm = re.search(r"\(([^)]+)\)", definition)
        cols = [c.strip().strip('"') for c in cm.group(1).split(",")] if cm else []
        live_indexes[name] = (table, cols)

    live_enums: dict[str, list[str]] = {}
    for typ, label in psql(
        target,
        "SELECT t.typname, e.enumlabel FROM pg_type t "
        "JOIN pg_enum e ON e.enumtypid = t.oid ORDER BY t.typname, e.enumsortorder",
    ):
        live_enums.setdefault(typ, []).append(label)

    problems: list[str] = []

    for table, cols in sql_tables.items():
        if table not in live_cols:
            problems.append(f"TABLE {table}: in code but missing from live DB")
            continue
        for col, spec in cols.items():
            lc = live_cols[table].get(col)
            if lc is None:
                problems.append(f"COLUMN {table}.{col}: in code but missing from live DB")
                continue
            if not type_matches(spec["type"], lc):
                problems.append(
                    f"TYPE {table}.{col}: code says {spec['type']}, live is {lc['data_type']}/{lc['udt']}"
                )
            if spec["notnull"] != lc["notnull"]:
                problems.append(
                    f"NULLABILITY {table}.{col}: code notnull={spec['notnull']}, live notnull={lc['notnull']}"
                )
        for col in live_cols[table]:
            if col not in cols:
                problems.append(f"EXTRA COLUMN {table}.{col}: in live DB but not in code")

    for table in live_cols:
        if table not in sql_tables:
            problems.append(f"EXTRA TABLE {table}: in live DB but not in code")

    for name, (table, cols) in sql_indexes.items():
        if name not in live_indexes:
            problems.append(f"INDEX {name}: in code but missing from live DB")
            continue
        lt, lcols = live_indexes[name]
        if lt != table or lcols != cols:
            problems.append(f"INDEX {name}: code ({table}: {cols}), live ({lt}: {lcols})")

    for name, values in sql_enums.items():
        if name not in live_enums:
            problems.append(f"ENUM {name}: in code but missing from live DB")
        elif live_enums[name] != values:
            problems.append(f"ENUM {name}: code {values}, live {live_enums[name]}")

    for name in live_enums:
        if name not in sql_enums:
            problems.append(f"EXTRA ENUM {name}: in live DB but not in code")

    print(
        f"checked: {len(sql_tables)} tables, {sum(len(c) for c in sql_tables.values())} columns, "
        f"{len(sql_indexes)} indexes, {len(sql_enums)} enums"
    )
    if problems:
        print(f"\n{len(problems)} MISMATCH(ES):")
        for p in problems:
            print(" -", p)
        print("\nfix: re-run the setup-db route against this database, then re-check")
        sys.exit(1)
    print("live database matches the code exactly")


if __name__ == "__main__":
    main()
