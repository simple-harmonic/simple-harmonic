import {
  deleteConnectorByKey,
  listConnectorMetas,
  resolveConnector,
  saveConnector,
} from "../../connectors";
import { toolsEnabled, toolsRoot } from "../../tools/sandbox";
import { isValidConnectorKey } from "../../validation";

const KEY_FORMAT_ERROR =
  "key must be uppercase letters, digits, and underscores (e.g. GITHUB_TOKEN)";

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
      description: "GitHub personal access token for the github_api tool.",
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

  return Response.json({
    connectors: [...builtin, ...fileConnectors],
  });
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    name?: string;
    key?: string;
    value?: string;
    description?: string;
    type?: "api_key" | "oauth_token" | "env_var";
  };
  const { name, key, value, description, type } = body;

  if (!name || !key) {
    return Response.json({ error: "name and key are required" }, { status: 400 });
  }

  if (!isValidConnectorKey(key)) {
    return Response.json({ error: KEY_FORMAT_ERROR }, { status: 400 });
  }

  saveConnector(
    { name, key, description: description ?? "", type: type ?? "api_key" },
    value || undefined,
  );

  return Response.json({ ok: true, key });
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const key = searchParams.get("key");

  if (!key) {
    return Response.json({ error: "key is required" }, { status: 400 });
  }

  if (!isValidConnectorKey(key)) {
    return Response.json({ error: KEY_FORMAT_ERROR }, { status: 400 });
  }

  const deleted = deleteConnectorByKey(key);
  if (!deleted) {
    return Response.json({ error: "Connector not found" }, { status: 404 });
  }

  return Response.json({ ok: true });
}
