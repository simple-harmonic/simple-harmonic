import { constantTimeEqual, OPERATOR_COOKIE, sha256Hex } from "../operator-auth";

// Operator login: exchange the shared OPERATOR_PASSWORD for the sh_operator
// session cookie (= sha256(password)). Excluded from the proxy gate.
export async function POST(req: Request) {
  const password = process.env.OPERATOR_PASSWORD;
  if (!password) {
    return Response.json({ error: "OPERATOR_PASSWORD not configured" }, { status: 503 });
  }

  const body = (await req.json().catch(() => ({}))) as { password?: unknown };
  const submitted = typeof body.password === "string" ? body.password : "";

  if (!constantTimeEqual(submitted, password)) {
    return Response.json({ error: "Invalid password" }, { status: 401 });
  }

  const res = Response.json({ ok: true });
  const secure = process.env.NODE_ENV === "production";
  res.headers.append(
    "Set-Cookie",
    `${OPERATOR_COOKIE}=${await sha256Hex(password)}; HttpOnly${secure ? "; Secure" : ""}; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 30}`, // 30 days
  );
  return res;
}
