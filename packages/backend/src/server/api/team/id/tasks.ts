import {
  COFOUNDER_AGENT_ID,
  COFOUNDER_POV,
  resolveCofounderName,
  USER_AGENT_ID,
  USER_DISPLAY_NAME,
  USER_POV,
} from "../../../../lib/meta-agent/identity";
import { getA2AX } from "../../../a2ax";
import { agents, teams } from "../../../store";

// GET /api/team/[id]/tasks?agentId=xxx
// Special agentIds: "team" (all tasks), "cofounder" (tasks the cofounder is on)
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: teamId } = await params;
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");

  if (!agentId) {
    return Response.json({ error: "agentId query param required" }, { status: 400 });
  }

  const a2ax = getA2AX();

  const agentRows = await agents.byTeam(teamId);
  const nameMap: Record<string, string> = Object.fromEntries(agentRows.map((a) => [a.id, a.name]));
  const teamRow = await teams.byId(teamId);
  nameMap[COFOUNDER_AGENT_ID] = resolveCofounderName(teamRow?.cofounderName);
  nameMap[USER_AGENT_ID] = USER_DISPLAY_NAME;

  const isTeamOverview = agentId === "team";
  const participantId =
    agentId === COFOUNDER_POV ? COFOUNDER_AGENT_ID : agentId === USER_POV ? USER_AGENT_ID : agentId;

  const tasks = (await a2ax.listTasks(teamId, isTeamOverview ? undefined : participantId))
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime())
    .slice(0, 200);

  const enriched = tasks.map((t) => ({
    id: t.id,
    title: t.title,
    description: t.description,
    state: t.state,
    requestorId: t.requestorId,
    requestorName: nameMap[t.requestorId] ?? t.requestorId,
    assigneeId: t.assigneeId,
    assigneeName: nameMap[t.assigneeId] ?? t.assigneeId,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  }));

  return Response.json(enriched);
}
