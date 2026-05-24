import { execSync } from "node:child_process";
import { NextResponse } from "next/server";
import { Pool } from "pg";
import { getConfig, setConfig } from "@/server/config";

/** Extract a useful message from pg errors (which sometimes have empty .message but a .code) */
function pgError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  const code = (err as { code?: string }).code;
  if (code === "ECONNREFUSED") return "Connection refused. Is PostgreSQL running?";
  if (code === "ENOTFOUND") return "Host not found. Check your connection URL.";
  if (code === "ETIMEDOUT") return "Connection timed out.";
  if (code) return `pg error code: ${code}`;
  return String(err);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const steps: string[] = [];

  // Use provided URL or current config
  const dbUrl =
    (typeof body.databaseUrl === "string" && body.databaseUrl) || getConfig().databaseUrl;
  if (!dbUrl) {
    return NextResponse.json({ ok: false, error: "No database URL provided", steps });
  }

  // Save the URL to config if provided
  if (body.databaseUrl) {
    setConfig({ databaseUrl: body.databaseUrl });
    steps.push("Saved database URL to config");
  }

  // Parse the URL to extract database name
  let parsed: URL;
  try {
    parsed = new URL(dbUrl);
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid database URL", steps });
  }

  const dbName = parsed.pathname.replace(/^\//, "");
  if (!dbName) {
    return NextResponse.json({ ok: false, error: "No database name in URL", steps });
  }

  // Step 1: Connect to the default 'postgres' database and create target DB
  const adminUrl = new URL(dbUrl);
  adminUrl.pathname = "/postgres";

  const adminPool = new Pool({
    connectionString: adminUrl.toString(),
    max: 1,
    connectionTimeoutMillis: 5000,
  });

  try {
    const client = await adminPool.connect();
    steps.push(`Connected to ${parsed.host}`);
    try {
      // Check if database exists
      const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
      if (exists.rowCount === 0) {
        // CREATE DATABASE can't use parameterized queries, sanitize manually
        const safeName = dbName.replace(/[^a-zA-Z0-9_-]/g, "");
        await client.query(`CREATE DATABASE "${safeName}"`);
        steps.push(`Created database "${safeName}"`);
      } else {
        steps.push(`Database "${dbName}" already exists`);
      }
    } finally {
      client.release();
    }
  } catch (err) {
    await adminPool.end().catch(() => {});
    return NextResponse.json({
      ok: false,
      error: pgError(err),
      steps,
    });
  }
  await adminPool.end().catch(() => {});

  // Step 2: Run drizzle-kit push to create/sync tables
  try {
    const projectRoot = process.cwd();
    execSync("npx drizzle-kit push --force", {
      cwd: projectRoot,
      env: { ...process.env, DATABASE_URL: dbUrl },
      timeout: 30000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    steps.push("Schema pushed successfully");
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr;
    const msg = stderr || pgError(err);
    return NextResponse.json({
      ok: false,
      error: `Schema push failed: ${msg}`.slice(0, 500),
      steps,
    });
  }

  // Step 3: Verify connection to the actual database
  const verifyPool = new Pool({
    connectionString: dbUrl,
    max: 1,
    connectionTimeoutMillis: 5000,
  });
  try {
    const client = await verifyPool.connect();
    const tables = await client.query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const tableNames = tables.rows.map((r) => r.tablename as string);
    client.release();
    steps.push(`Tables: ${tableNames.join(", ") || "none"}`);
  } catch {
    steps.push("Warning: could not verify tables");
  }
  await verifyPool.end().catch(() => {});

  return NextResponse.json({ ok: true, steps });
}
