import {
  constantTimeEqual,
  OPERATOR_COOKIE,
  sha256Hex,
} from "@simple-harmonic/backend/server/operator-auth";
import { NextResponse } from "next/server";

// Operator login: exchange the shared OPERATOR_PASSWORD for the sh_operator
// session cookie (= sha256(password)). Excluded from the proxy gate.
export async function POST(req: Request) {
  const password = process.env.OPERATOR_PASSWORD;
  if (!password) {
    return NextResponse.json({ error: "OPERATOR_PASSWORD not configured" }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as { password?: unknown };
  const submitted = typeof body.password === "string" ? body.password : "";

  if (!constantTimeEqual(submitted, password)) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(OPERATOR_COOKIE, await sha256Hex(password), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
