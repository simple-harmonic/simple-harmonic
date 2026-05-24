import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { getConfig } from "@/server/config";
import * as schema from "./schema";

let instance: NodePgDatabase<typeof schema> | null = null;
let instanceUrl: string | null = null;

export function db() {
  const { databaseUrl } = getConfig();
  // Recreate if config changed
  if (instance && instanceUrl !== databaseUrl) {
    instance = null;
    instanceUrl = null;
  }
  if (!instance) {
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 5,
    });
    instance = drizzle({ client: pool, schema });
    instanceUrl = databaseUrl;
  }
  return instance;
}
