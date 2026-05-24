import { NextResponse } from "next/server";
import { Pool } from "pg";
import { getConfig } from "@/server/config";

export async function POST() {
  const { databaseUrl } = getConfig();
  if (!databaseUrl) {
    return NextResponse.json({ ok: false, error: "No database URL configured" });
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5000 });
  try {
    const client = await pool.connect();
    const result = await client.query("SELECT 1 as ok");
    client.release();
    await pool.end();
    return NextResponse.json({ ok: result.rows[0]?.ok === 1 });
  } catch (err) {
    await pool.end().catch(() => {});
    return NextResponse.json({
      ok: false,
      error: err instanceof Error ? err.message : "Connection failed",
    });
  }
}
