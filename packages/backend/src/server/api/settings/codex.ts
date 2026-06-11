import {
  getCodexAuthStatus,
  getCodexModels,
  refreshCodexToken,
} from "../../codex-auth";

export async function GET() {
  return Response.json({
    ...getCodexAuthStatus(),
    models: getCodexModels(),
  });
}

export async function POST() {
  const result = await refreshCodexToken();
  return Response.json(result);
}
