import {
  isOperatorAuthorized,
  isProductionRuntime,
} from "@simple-harmonic/backend/server/operator-auth";
import { type NextRequest, NextResponse } from "next/server";

// ---------------------------------------------------------------------------
// Operator gate (floor item 5). A single shared OPERATOR_PASSWORD protects the
// app. Enforcement is permissive in local dev when the password is unset (so
// `npm run dev` works out of the box) and fails closed in production.
//
// edge runtime: this file and operator-auth.ts use only Web Crypto + header
// parsing, no node-only APIs.
// ---------------------------------------------------------------------------

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // The tick endpoint runs its own cron-secret check (cron callers carry no
  // operator cookie); don't double-gate it here.
  if (pathname === "/api/tick" || pathname.startsWith("/api/tick/")) {
    return NextResponse.next();
  }

  const password = process.env.OPERATOR_PASSWORD;
  const isApi = pathname.startsWith("/api/");

  if (!password) {
    // No operator password configured: fail closed in production, open in dev.
    if (isProductionRuntime()) {
      return isApi
        ? NextResponse.json({ error: "OPERATOR_PASSWORD not configured" }, { status: 503 })
        : new NextResponse("OPERATOR_PASSWORD not configured", { status: 503 });
    }
    return NextResponse.next();
  }

  if (await isOperatorAuthorized(req, password)) {
    return NextResponse.next();
  }

  if (isApi) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Page request: send the operator to the login screen.
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next internals, the favicon, and the login surfaces
  // (which must stay reachable so the operator can authenticate).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|login|api/login).*)"],
};
