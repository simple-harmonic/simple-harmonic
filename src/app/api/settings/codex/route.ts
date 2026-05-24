import { NextResponse } from "next/server";
import { getCodexAuthStatus, getCodexModels, refreshCodexToken } from "@/server/codex-auth";

export async function GET() {
  return NextResponse.json({
    ...getCodexAuthStatus(),
    models: getCodexModels(),
  });
}

export async function POST() {
  const result = await refreshCodexToken();
  return NextResponse.json(result);
}
