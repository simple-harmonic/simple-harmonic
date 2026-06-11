import {
  COFOUNDER_AGENT_ID,
  COFOUNDER_POV,
  resolveCofounderName,
  USER_AGENT_ID,
  USER_DISPLAY_NAME,
  USER_POV,
} from "../../../../lib/meta-agent/identity";
import { db } from "../../../db";
import { a2axTasks, agents, teams } from "../../../db/schema";
import { and, eq, or } from "drizzle-orm";

// GET /api/team/[id]/tasks?agentId=xxx
// Special agentIds: "team" (all tasks), "cofounder" (tasks the cofounder is on)
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: teamId } = await params;
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");

  if (!agentId) {
    return Response.json({ error: "agentId query param required" }, { status: 400 });
  }

  const d = db();

  const agentRows = await d.query.agents.findMany({
    where: eq(agents.teamId, teamId),
  });
  const nameMap: Record<string, string> = Object.fromEntries(agentRows.map((a) => [a.id, a.name]));
  const teamRow = await d.query.teams.findFirst({ where: eq(teams.id, teamId) });
  nameMap[COFOUNDER_AGENT_ID] = resolveCofounderName(teamRow?.cofounderName);
  nameMap[USER_AGENT_ID] = USER_DISPLAY_NAME;

  const isTeamOverview = agentId === "team";
  const participantId =
    agentId === COFOUNDER_POV ? COFOUNDER_AGENT_ID : agentId === USER_POV ? USER_AGENT_ID : agentId;

  const tasks = isTeamOverview
    ? await d
        .select()
        .from(a2axTasks)
        .where(eq(a2axTasks.teamId, teamId))
        .orderBy(a2axTasks.updatedAt)
        .limit(200)
    : await d
        .select()
        .from(a2axTasks)
        .where(
          and(
            eq(a2axTasks.teamId, teamId),
            or(eq(a2axTasks.requestorId, participantId), eq(a2axTasks.assigneeId, participantId)),
          ),
        )
        .orderBy(a2axTasks.updatedAt)
        .limit(200);

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
