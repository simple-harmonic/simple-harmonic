import {
  COFOUNDER_AGENT_ID,
  COFOUNDER_POV,
  resolveCofounderName,
  USER_AGENT_ID,
  USER_DISPLAY_NAME,
  USER_POV,
} from "../../../../lib/meta-agent/identity";
import { db } from "../../../db";
import { a2axMessages, a2axTasks, agents, teams } from "../../../db/schema";
import { eq } from "drizzle-orm";

// GET /api/team/[id]/conversations?agentId=xxx
// Special agentIds: "cofounder" (all messages), "team" (broadcast + group only)
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: teamId } = await params;
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");

  if (!agentId) {
    return Response.json({ error: "agentId query param required" }, { status: 400 });
  }

  const d = db();

  const [agentRows, teamRow] = await Promise.all([
    d.query.agents.findMany({ where: eq(agents.teamId, teamId) }),
    d.query.teams.findFirst({ where: eq(teams.id, teamId) }),
  ]);
  const cofounderName = resolveCofounderName(teamRow?.cofounderName);
  const nameMap: Record<string, string> = Object.fromEntries(agentRows.map((a) => [a.id, a.name]));
  nameMap[COFOUNDER_AGENT_ID] = cofounderName;
  nameMap[USER_AGENT_ID] = USER_DISPLAY_NAME;

  const isTeamOverview = agentId === "team";
  // Cofounder/user POVs translate to their sentinel UUIDs to query like participants.
  const participantId =
    agentId === COFOUNDER_POV ? COFOUNDER_AGENT_ID : agentId === USER_POV ? USER_AGENT_ID : agentId;

  const allMessages = await d
    .select()
    .from(a2axMessages)
    .where(eq(a2axMessages.teamId, teamId))
    .orderBy(a2axMessages.createdAt)
    .limit(1000);

  // Team overview sees everything. Otherwise filter to messages involving the
  // participant (cofounder is treated as a participant with literal id "cofounder").
  const messages = isTeamOverview
    ? allMessages
    : allMessages.filter((m) => {
        if (m.channelType === "broadcast") return true;
        if (m.fromAgentId === participantId) return true;
        if (m.channelType === "direct" && m.channelId.includes(participantId)) return true;
        if (m.channelType === "group" && m.channelId.includes(participantId)) return true;
        if (m.channelType === "task" && m.channelId.includes(participantId)) return true;
        return false;
      });

  // Resolve task titles for task channels
  const taskRows = await d
    .select({ id: a2axTasks.id, title: a2axTasks.title })
    .from(a2axTasks)
    .where(eq(a2axTasks.teamId, teamId));
  const taskTitleMap = Object.fromEntries(taskRows.map((t) => [`task:${t.id}`, t.title]));

  // Group by channelId to form threads
  const threads = new Map<
    string,
    {
      channelId: string;
      channelType: string;
      peerAgentId: string | null;
      peerAgentName: string | null;
      messages: Array<{
        id: string;
        fromAgentId: string;
        fromAgentName: string;
        content: string;
        kind: string;
        status: string;
        urgent: boolean;
        createdAt: string;
        isSelf: boolean;
      }>;
    }
  >();

  for (const m of messages) {
    if (!threads.has(m.channelId)) {
      let peerAgentId: string | null = null;
      let peerAgentName: string | null = null;

      if (m.channelType === "direct") {
        const parts = m.channelId.split(":");
        const id1 = parts[1];
        const id2 = parts[2];
        if (isTeamOverview) {
          // Show both agent names
          const name1 = nameMap[id1 ?? ""] ?? id1;
          const name2 = nameMap[id2 ?? ""] ?? id2;
          peerAgentName = `${name1} ↔ ${name2}`;
        } else {
          peerAgentId = id1 === participantId ? (id2 ?? null) : (id1 ?? null);
          peerAgentName = peerAgentId ? (nameMap[peerAgentId] ?? peerAgentId) : null;
        }
      } else if (m.channelType === "broadcast") {
        peerAgentName = "Team Broadcast";
      } else if (m.channelType === "group") {
        peerAgentName = "Group Chat";
      } else if (m.channelType === "task") {
        peerAgentName = taskTitleMap[m.channelId] ?? m.channelId;
      }

      threads.set(m.channelId, {
        channelId: m.channelId,
        channelType: m.channelType,
        peerAgentId,
        peerAgentName,
        messages: [],
      });
    }

    threads.get(m.channelId)!.messages.push({
      id: m.id,
      fromAgentId: m.fromAgentId,
      fromAgentName: nameMap[m.fromAgentId] ?? m.fromAgentId,
      content: m.content,
      kind: m.kind,
      status: m.status,
      urgent: m.urgent,
      createdAt: m.createdAt.toISOString(),
      isSelf: !isTeamOverview && m.fromAgentId === participantId,
    });
  }

  const sortedThreads = Array.from(threads.values()).sort((a, b) => {
    const aLast = a.messages[a.messages.length - 1]?.createdAt ?? "";
    const bLast = b.messages[b.messages.length - 1]?.createdAt ?? "";
    return bLast.localeCompare(aLast);
  });

  const displayName = isTeamOverview ? "Team Overview" : (nameMap[participantId] ?? participantId);

  return Response.json({
    agentId,
    agentName: displayName,
    threads: sortedThreads,
  });
}
