import { sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import {
  COFOUNDER_AGENT_ID,
  USER_AGENT_ID,
  USER_DISPLAY_NAME,
  resolveCofounderName,
} from "@simple-harmonic/backend/lib/meta-agent/identity";
import { db } from "@simple-harmonic/backend/server/db";

// GET /api/team/[id]/agent-hub?agentId=xxx
// Single SQL round-trip returning agents, team cofounder name, action log, and
// messages. Neon adds ~300ms network latency per query, so batching into one
// query is critical.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: teamId } = await params;
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");

  if (!agentId) {
    return NextResponse.json(
      { error: "agentId query param required" },
      { status: 400 },
    );
  }

  const d = db();

  const result = await d.execute(sql`
    SELECT json_build_object(
      'agents', (SELECT coalesce(json_agg(row_to_json(a)), '[]') FROM agents a WHERE a.team_id = ${teamId}),
      'cofounderName', (SELECT t.cofounder_name FROM teams t WHERE t.id = ${teamId}),
      'actions', (SELECT coalesce(json_agg(row_to_json(al)), '[]') FROM (
        SELECT id, action_type, payload, executed_at FROM action_log
        WHERE agent_id = ${agentId} ORDER BY executed_at DESC LIMIT 100
      ) al),
      'messages', (SELECT coalesce(json_agg(row_to_json(m)), '[]') FROM (
        SELECT id, channel_type, channel_id, from_agent_id, kind, content, created_at
        FROM a2ax_messages WHERE team_id = ${teamId} ORDER BY created_at LIMIT 200
      ) m)
    ) as data
  `);

  const data = (result.rows[0] as { data: {
    agents: Array<{ id: string; name: string; role: string; status: string; schedule_seconds: number; next_run_at: string | null; in_flight: boolean }>;
    cofounderName: string | null;
    actions: Array<{ id: string; action_type: string; payload: Record<string, unknown>; executed_at: string }>;
    messages: Array<{ id: string; channel_type: string; channel_id: string; from_agent_id: string; kind: string; content: string; created_at: string }>;
  }}).data;

  const cofounderName = resolveCofounderName(data.cofounderName);
  const nameMap: Record<string, string> = Object.fromEntries(
    data.agents.map((a) => [a.id, a.name]),
  );
  nameMap[COFOUNDER_AGENT_ID] = cofounderName;
  nameMap[USER_AGENT_ID] = USER_DISPLAY_NAME;

  const isCofounder = agentId === COFOUNDER_AGENT_ID;
  const isUser = agentId === USER_AGENT_ID;
  const agent = (isCofounder || isUser) ? null : data.agents.find((a) => a.id === agentId);
  if (!isCofounder && !isUser && !agent) {
    return NextResponse.json({ error: "agent not found" }, { status: 404 });
  }

  const receivedMessages = data.messages.filter((m) => {
    if (m.from_agent_id === agentId) return false;
    if (m.channel_type === "broadcast") return true;
    if (m.channel_id.includes(agentId)) return true;
    return false;
  });

  const sentMessages = (isCofounder || isUser)
    ? data.messages.filter((m) => m.from_agent_id === agentId)
    : [];

  type TimelineAction = { type: "action"; id: string; actionType: string; payload: Record<string, unknown>; timestamp: string };
  type TimelineReceived = { type: "received"; id: string; fromName: string; content: string; kind: string; channelType: string; timestamp: string };
  type TimelineSent = { type: "sent"; id: string; toName: string; content: string; kind: string; channelType: string; timestamp: string };

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
    ...sentMessages.map(
      (m): TimelineSent => {
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
      },
    ),
  ].sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );

  return NextResponse.json({
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
