import {
  COFOUNDER_AGENT_ID,
  resolveCofounderName,
  USER_AGENT_ID,
  USER_DISPLAY_NAME,
} from "../../../../lib/meta-agent/identity";
import { getA2AX } from "../../../a2ax";
import { actionLog, agents, teams } from "../../../store";

// GET /api/team/[id]/agent-hub?agentId=xxx
// Returns the team's agents, cofounder name, the agent's recent action log, and
// the team's messages in one shot for the agent dashboard.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: teamId } = await params;
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");

  if (!agentId) {
    return Response.json({ error: "agentId query param required" }, { status: 400 });
  }

  const a2ax = getA2AX();

  const [agentRows, teamRow, actionRows, messageRows] = await Promise.all([
    agents.byTeam(teamId),
    teams.byId(teamId),
    actionLog.recentByAgent(agentId, 100),
    a2ax.listMessages(teamId, 200),
  ]);

  const data = {
    agents: agentRows.map((a) => ({
      id: a.id,
      name: a.name,
      role: a.role,
      status: a.status as string,
      schedule_seconds: a.scheduleSeconds,
      next_run_at: a.nextRunAt ? a.nextRunAt.toISOString() : null,
      in_flight: a.inFlight,
    })),
    cofounderName: teamRow?.cofounderName ?? null,
    actions: actionRows.map((r) => ({
      id: r.id,
      action_type: r.actionType,
      payload: r.payload,
      executed_at: r.executedAt.toISOString(),
    })),
    messages: messageRows.map((m) => ({
      id: m.id,
      channel_type: m.channelType as string,
      channel_id: m.channelId,
      from_agent_id: m.fromAgentId,
      kind: m.kind as string,
      content: m.content,
      created_at: m.createdAt.toISOString(),
    })),
  };

  const cofounderName = resolveCofounderName(data.cofounderName);
  const nameMap: Record<string, string> = Object.fromEntries(
    data.agents.map((a) => [a.id, a.name]),
  );
  nameMap[COFOUNDER_AGENT_ID] = cofounderName;
  nameMap[USER_AGENT_ID] = USER_DISPLAY_NAME;

  const isCofounder = agentId === COFOUNDER_AGENT_ID;
  const isUser = agentId === USER_AGENT_ID;
  const agent = isCofounder || isUser ? null : data.agents.find((a) => a.id === agentId);
  if (!isCofounder && !isUser && !agent) {
    return Response.json({ error: "agent not found" }, { status: 404 });
  }

  const receivedMessages = data.messages.filter((m) => {
    if (m.from_agent_id === agentId) return false;
    if (m.channel_type === "broadcast") return true;
    if (m.channel_id.includes(agentId)) return true;
    return false;
  });

  const sentMessages =
    isCofounder || isUser ? data.messages.filter((m) => m.from_agent_id === agentId) : [];

  type TimelineAction = {
    type: "action";
    id: string;
    actionType: string;
    payload: Record<string, unknown>;
    timestamp: string;
  };
  type TimelineReceived = {
    type: "received";
    id: string;
    fromName: string;
    content: string;
    kind: string;
    channelType: string;
    timestamp: string;
  };
  type TimelineSent = {
    type: "sent";
    id: string;
    toName: string;
    content: string;
    kind: string;
    channelType: string;
    timestamp: string;
  };

  const timeline: Array<TimelineAction | TimelineReceived | TimelineSent> = [
    ...data.actions.map(
      (a): TimelineAction => ({
        type: "action",
        id: a.id,
        actionType: a.action_type,
        payload: a.payload as Record<string, unknown>,
        timestamp: a.executed_at,
      }),
    ),
    ...receivedMessages.map(
      (m): TimelineReceived => ({
        type: "received",
        id: m.id,
        fromName: nameMap[m.from_agent_id] ?? m.from_agent_id,
        content: m.content,
        kind: m.kind,
        channelType: m.channel_type,
        timestamp: m.created_at,
      }),
    ),
    ...sentMessages.map((m): TimelineSent => {
      const peers = m.channel_id.split(":").filter((id: string) => id !== agentId);
      const toName = peers.map((id: string) => nameMap[id] ?? id).join(", ") || m.channel_type;
      return {
        type: "sent",
        id: `sent-${m.id}`,
        toName,
        content: m.content,
        kind: m.kind,
        channelType: m.channel_type,
        timestamp: m.created_at,
      };
    }),
  ].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

  return Response.json({
    agentId,
    agentName: isUser ? USER_DISPLAY_NAME : isCofounder ? cofounderName : agent!.name,
    agentRole: isUser ? "Founder" : isCofounder ? "AI Cofounder" : agent!.role,
    agentStatus: isUser ? "running" : isCofounder ? "running" : agent!.status,
    agentSchedule: isUser ? 0 : isCofounder ? 0 : agent!.schedule_seconds,
    nextRunAt: isUser ? null : isCofounder ? null : (agent!.next_run_at ?? null),
    inFlight: isUser ? false : isCofounder ? false : agent!.in_flight,
    timeline,
  });
}
