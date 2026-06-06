// ---------------------------------------------------------------------------
// Operator / cron auth helpers.
//
// EDGE-SAFE: uses only Web Crypto (globalThis.crypto), TextEncoder, and header
// parsing, so this file can be imported from Next middleware (edge runtime) as
// well as node route handlers and vitest. Do NOT add node:crypto, node:fs, the
// DB, or any node-only import here.
//
// Single-operator model for v0.0: one shared OPERATOR_PASSWORD gates the app;
// one CRON_SECRET gates the tick endpoint. Enforcement is permissive in local
// dev when the secret is unset (so `npm run dev` works out of the box) and
// fails closed in production / on Vercel.
// ---------------------------------------------------------------------------

export const OPERATOR_COOKIE = "sh_operator";

/** True when an unset secret should fail closed (production / Vercel). */
export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === "production" || !!process.env.VERCEL;
}

/** SHA-256 hex digest via Web Crypto (works in edge + node). */
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Length-checked constant-time string comparison. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(/; */)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

/**
 * Is the request an authorized operator? Accepts a Bearer OPERATOR_PASSWORD
 * (for curl/scripts) or the sh_operator cookie (= sha256(password)).
 */
export async function isOperatorAuthorized(
  req: Request,
  password: string,
): Promise<boolean> {
  const tok = bearerToken(req);
  if (tok && constantTimeEqual(tok, password)) return true;
  const cookie = readCookie(req, OPERATOR_COOKIE);
  if (cookie && constantTimeEqual(cookie, await sha256Hex(password))) return true;
  return false;
}

/**
 * Is the tick request authorized? Accepts the Vercel platform cron header
 * (x-vercel-cron) or a Bearer CRON_SECRET. When CRON_SECRET is unset, allows in
 * local dev and fails closed in production.
 */
export function isCronAuthorized(
  req: Request,
  cronSecret: string | undefined,
): boolean {
  if (req.headers.get("x-vercel-cron")) return true;
  if (cronSecret) {
    const tok = bearerToken(req);
    return !!tok && constantTimeEqual(tok, cronSecret);
  }
  return !isProductionRuntime();
}
