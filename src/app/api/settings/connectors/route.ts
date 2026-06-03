import { NextResponse } from "next/server";
import { toolsEnabled, toolsRoot } from "@simple-harmonic/backend/server/tools/sandbox";

interface ConnectorStatus {
  id: string;
  name: string;
  description: string;
  configured: boolean;
  maskedValue?: string;
  envVar: string;
}

function maskSecret(s: string): string {
  if (!s) return "";
  if (s.length <= 8) return "********";
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function getConnectors(): ConnectorStatus[] {
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
  const githubToken = process.env.GITHUB_TOKEN ?? "";

  return [
    {
      id: "tools-enabled",
      name: "Agent Tools",
      description:
        "Master switch for destructive tools (write_file, run_command, mutating github_api). Read-only tools always work.",
      configured: toolsEnabled(),
      maskedValue: toolsEnabled() ? "enabled" : "disabled",
      envVar: "SH_ENABLE_TOOLS",
    },
    {
      id: "tools-cwd",
      name: "Project Root",
      description:
        "Working directory for agent file and shell operations. All paths are jailed to this directory.",
      configured: true,
      maskedValue: toolsRoot(),
      envVar: "SH_TOOLS_CWD",
    },
    {
      id: "anthropic",
      name: "Anthropic API",
      description: "Claude models for agent LLM calls. Required for the default provider.",
      configured: anthropicKey.length > 0,
      maskedValue: anthropicKey ? maskSecret(anthropicKey) : undefined,
      envVar: "ANTHROPIC_API_KEY",
    },
    {
      id: "github",
      name: "GitHub",
      description:
        "GitHub personal access token for the github_api tool. Required for creating issues, reading PRs, and other GitHub operations.",
      configured: githubToken.length > 0,
      maskedValue: githubToken ? maskSecret(githubToken) : undefined,
      envVar: "GITHUB_TOKEN",
    },
    {
      id: "database",
      name: "Database",
      description: "Neon Postgres connection. Must use pooler.neon.tech for serverless.",
      configured: (process.env.DATABASE_URL ?? "").length > 0,
      maskedValue: process.env.DATABASE_URL
        ? process.env.DATABASE_URL.replace(/:([^@]+)@/, ":****@")
        : undefined,
      envVar: "DATABASE_URL",
    },
  ];
}

export async function GET() {
  return NextResponse.json({ connectors: getConnectors() });
}
