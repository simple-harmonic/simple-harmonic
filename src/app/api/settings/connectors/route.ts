import { NextResponse } from "next/server";
import { toolsEnabled, toolsRoot } from "@simple-harmonic/backend/server/tools/sandbox";
import {
  listConnectorMetas,
  resolveConnector,
  saveConnector,
  deleteConnectorByKey,
} from "@simple-harmonic/backend/server/connectors";

interface ConnectorStatus {
  id: string;
  name: string;
  description: string;
  configured: boolean;
  maskedValue?: string;
  envVar: string;
  source: "env" | "file";
}

function maskSecret(s: string): string {
  if (!s) return "";
  if (s.length <= 8) return "********";
  return `${s.slice(0, 4)}****${s.slice(-4)}`;
}

function getBuiltinConnectors(): ConnectorStatus[] {
  const anthropicKey = process.env.ANTHROPIC_API_KEY ?? "";
  const githubToken = resolveConnector("GITHUB_TOKEN");

  return [
    {
      id: "builtin-tools-enabled",
      name: "Agent Tools",
      description:
        "Master switch for destructive tools (write_file, run_command, mutating github_api). Read-only tools always work.",
      configured: toolsEnabled(),
      maskedValue: toolsEnabled() ? "enabled" : "disabled",
      envVar: "SH_ENABLE_TOOLS",
      source: "env",
    },
    {
      id: "builtin-tools-cwd",
      name: "Project Root",
      description:
        "Working directory for agent file and shell operations. All paths are jailed to this directory.",
      configured: true,
      maskedValue: toolsRoot(),
      envVar: "SH_TOOLS_CWD",
      source: "env",
    },
    {
      id: "builtin-anthropic",
      name: "Anthropic API",
      description: "Claude models for agent LLM calls.",
      configured: anthropicKey.length > 0,
      maskedValue: anthropicKey ? maskSecret(anthropicKey) : undefined,
      envVar: "ANTHROPIC_API_KEY",
      source: "env",
    },
    {
      id: "builtin-github",
      name: "GitHub",
      description:
        "GitHub personal access token for the github_api tool.",
      configured: !!githubToken,
      maskedValue: githubToken ? maskSecret(githubToken) : undefined,
      envVar: "GITHUB_TOKEN",
      source: "env",
    },
    {
      id: "builtin-database",
      name: "Database",
      description: "Neon Postgres connection.",
      configured: (process.env.DATABASE_URL ?? "").length > 0,
      maskedValue: process.env.DATABASE_URL
        ? process.env.DATABASE_URL.replace(/:([^@]+)@/, ":****@")
        : undefined,
      envVar: "DATABASE_URL",
      source: "env",
    },
  ];
}

export async function GET() {
  const builtin = getBuiltinConnectors();

  const fileMetas = listConnectorMetas();
  const fileConnectors: ConnectorStatus[] = fileMetas
    .filter((m) => !builtin.some((b) => b.envVar === m.key))
    .map((m) => {
      const value = resolveConnector(m.key);
      return {
        id: `file-${m.key}`,
        name: m.name,
        description: m.description,
        configured: !!value,
        maskedValue: value ? maskSecret(value) : undefined,
        envVar: m.key,
        source: "file" as const,
      };
    });

  return NextResponse.json({
    connectors: [...builtin, ...fileConnectors],
  });
}

export async function POST(req: Request) {
  const body = await req.json();
  const { name, key, value, description, type } = body;

  if (!name || !key) {
    return NextResponse.json(
      { error: "name and key are required" },
      { status: 400 },
    );
  }

  saveConnector(
    { name, key, description: description ?? "", type: type ?? "api_key" },
    value || undefined,
  );

  return NextResponse.json({ ok: true, key });
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");

  if (!key) {
    return NextResponse.json({ error: "key is required" }, { status: 400 });
  }

  const deleted = deleteConnectorByKey(key);
  if (!deleted) {
    return NextResponse.json({ error: "Connector not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
