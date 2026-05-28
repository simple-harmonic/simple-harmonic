import { NextResponse } from "next/server";
import { type getConfig, getSafeConfig, setConfig } from "@simple-harmonic/backend/server/config";

export async function GET() {
  return NextResponse.json(getSafeConfig());
}

export async function POST(req: Request) {
  const body = await req.json();
  const allowed: (keyof ReturnType<typeof getConfig>)[] = [
    "openaiApiKey",
    "openaiBaseUrl",
    "model",
    "databaseUrl",
  ];

  const update: Record<string, string> = {};
  for (const key of allowed) {
    if (typeof body[key] === "string" && body[key].length > 0) {
      update[key] = body[key];
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no valid fields" }, { status: 400 });
  }

  setConfig(update);
  return NextResponse.json(getSafeConfig());
}
