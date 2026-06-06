import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { getCodexAuthStatus } from "@simple-harmonic/backend/server/codex-auth";
import { NextResponse } from "next/server";

function codexAuthPath(): string {
  const home = process.env.CODEX_HOME || join(process.env.HOME || "~", ".codex");
  return join(home, "auth.json");
}

// Track the running login process
let loginProcess: ChildProcess | null = null;
let loginStartedAt = 0;

/**
 * POST: spawn `codex login` which opens the system browser for OAuth.
 * After auth completes, codex writes ~/.codex/auth.json automatically.
 *
 * Accepts ?force=true to bypass the "already authenticated" short-circuit.
 * Use this for re-auth (e.g., when the saved token is stale, the user wants
 * to switch accounts, or refresh has been failing).
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "true";

  const status = getCodexAuthStatus();
  if (!force && status.found && status.hasAccessToken) {
    return NextResponse.json({ ok: true, status: "already_authenticated" });
  }

  // Kill stale process (older than 5 minutes)
  if (loginProcess && Date.now() - loginStartedAt > 5 * 60 * 1000) {
    loginProcess.kill();
    loginProcess = null;
  }

  if (loginProcess) {
    return NextResponse.json({ ok: true, status: "already_running" });
  }

  // For force re-auth, delete ~/.codex/auth.json directly so `codex login`
  // doesn't see the existing token and short-circuit. Avoid spawning `codex
  // logout` because it can prompt interactively and hang with stdio:"ignore".
  if (force) {
    try {
      const path = codexAuthPath();
      if (existsSync(path)) unlinkSync(path);
    } catch {
      // best-effort; proceed to login regardless
    }
  }

  // Capture stdout/stderr so the dev can see what codex is doing (and so we
  // can return a useful error if the binary isn't on PATH or the OAuth URL
  // can't be auto-opened). Pipe instead of "ignore".
  let proc: ChildProcess;
  try {
    proc = spawn("codex", ["login"], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (err) {
    console.error("[codex-login] spawn failed:", err);
    return NextResponse.json(
      {
        ok: false,
        error: "Failed to spawn `codex` — is the codex CLI installed and on PATH?",
      },
      { status: 500 },
    );
  }

  // Surface codex output to the server log so the user can copy the auth URL
  // from the terminal if the browser doesn't auto-open.
  proc.stdout?.on("data", (chunk) => {
    process.stdout.write(`[codex login] ${chunk}`);
  });
  proc.stderr?.on("data", (chunk) => {
    process.stderr.write(`[codex login] ${chunk}`);
  });

  proc.unref();
  loginProcess = proc;
  loginStartedAt = Date.now();

  proc.on("exit", (code) => {
    if (code !== 0 && code !== null) {
      console.warn(`[codex-login] codex login exited with code ${code}`);
    }
    loginProcess = null;
  });

  proc.on("error", (err) => {
    console.error("[codex-login] process error:", err);
    loginProcess = null;
  });

  return NextResponse.json({ ok: true, status: "started" });
}

/** GET: check if login flow completed */
export async function GET() {
  const status = getCodexAuthStatus();
  return NextResponse.json({
    authenticated: status.found && status.hasAccessToken,
    loginRunning: loginProcess !== null,
  });
}
