import {
  type AppConfig,
  type CodingBackendConfig,
  type CodingBackendType,
  getConfig,
  getSafeConfig,
  setConfig,
} from "../../config";

export async function GET() {
  return Response.json(getSafeConfig());
}

export async function POST(req: Request) {
  const body = (await req.json()) as Record<string, unknown> & {
    codingConfig?: Partial<Record<CodingBackendType, CodingBackendConfig>>;
  };
  const stringFields: (keyof AppConfig)[] = [
    "openaiApiKey",
    "openaiBaseUrl",
    "model",
    "databaseUrl",
    "codingBackend",
  ];

  const update: Record<string, unknown> = {};
  for (const key of stringFields) {
    if (typeof body[key] === "string" && body[key].length > 0) {
      update[key] = body[key];
    }
  }

  if (body.codingConfig && typeof body.codingConfig === "object") {
    const current = getConfig().codingConfig;
    const merged = { ...current };
    for (const backend of ["codex", "claude-code", "opencode"] as const) {
      if (body.codingConfig[backend] && typeof body.codingConfig[backend] === "object") {
        merged[backend] = { ...current[backend], ...body.codingConfig[backend] };
      }
    }
    update.codingConfig = merged;
  }

  if (Object.keys(update).length === 0) {
    return Response.json({ error: "no valid fields" }, { status: 400 });
  }

  setConfig(update as Partial<AppConfig>);
  return Response.json(getSafeConfig());
}
