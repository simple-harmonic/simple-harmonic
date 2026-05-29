import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getConfig } from "../config";
import * as schema from "./schema";

let instance: NodePgDatabase<typeof schema> | null = null;
let pool: Pool | null = null;
let instanceUrl: string | null = null;

export function db() {
  const { databaseUrl } = getConfig();
  if (instance && instanceUrl !== databaseUrl) {
    pool?.end();
    instance = null;
    pool = null;
    instanceUrl = null;
  }
  if (!instance) {
    pool = new Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
    });
    instance = drizzle({ client: pool, schema });
    instanceUrl = databaseUrl;
  }
  return instance;
}
