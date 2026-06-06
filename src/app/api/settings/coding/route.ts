import { execFile } from "node:child_process";
import { getCodexAuthStatus } from "@simple-harmonic/backend/server/codex-auth";
import { getConfig } from "@simple-harmonic/backend/server/config";
import { NextResponse } from "next/server";

function checkCli(name: string): Promise<{ installed: boolean; version: string | null }> {
  return new Promise((resolve) => {
    execFile(name, ["--version"], { timeout: 5_000 }, (err, stdout) => {
      if (err) {
        resolve({ installed: false, version: null });
      } else {
        resolve({ installed: true, version: (stdout || "").trim().split("\n")[0] || null });
      }
    });
  });
}

function maskSecret(s: string): string {
  if (!s || s.length <= 8) return s ? "••••••••" : "";
  return `${s.slice(0, 4)}••••${s.slice(-4)}`;
}

export async function GET() {
  const cfg = getConfig();
  const [codex, claude, opencode] = await Promise.all([
    checkCli("codex"),
    checkCli("claude"),
    checkCli("opencode"),
  ]);

  const codexAuth = getCodexAuthStatus();
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
  const openaiKey = process.env.OPENAI_API_KEY ?? "";

  return NextResponse.json({
    current: cfg.codingBackend,
    codingConfig: cfg.codingConfig,
    backends: {
      codex: {
        installed: codex.installed,
        version: codex.version,
        authenticated: codexAuth.found && codexAuth.hasAccessToken,
        account: codexAuth.email,
        plan: codexAuth.plan,
        connectors: [
          {
            name: "Codex OAuth",
            envVar: "~/.codex/auth.json",
            configured: codexAuth.found && codexAuth.hasAccessToken,
            value: codexAuth.email || undefined,
          },
        ],
      },
      "claude-code": {
        installed: claude.installed,
        version: claude.version,
        authenticated: anthropicKey.length > 0,
        connectors: [
          {
            name: "Anthropic API Key",
            envVar: "ANTHROPIC_API_KEY",
            configured: anthropicKey.length > 0,
            value: anthropicKey ? maskSecret(anthropicKey) : undefined,
          },
        ],
      },
      opencode: {
        installed: opencode.installed,
        version: opencode.version,
        authenticated: anthropicKey.length > 0 || openaiKey.length > 0,
        connectors: [
          {
            name: "Anthropic API Key",
            envVar: "ANTHROPIC_API_KEY",
            configured: anthropicKey.length > 0,
            value: anthropicKey ? maskSecret(anthropicKey) : undefined,
          },
          {
            name: "OpenAI API Key",
            envVar: "OPENAI_API_KEY",
            configured: openaiKey.length > 0,
            value: openaiKey ? maskSecret(openaiKey) : undefined,
          },
        ],
      },
    },
  });
}
