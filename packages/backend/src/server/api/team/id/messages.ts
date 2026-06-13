import {
  COFOUNDER_AGENT_ID,
  COFOUNDER_POV,
  USER_AGENT_ID,
  USER_POV,
} from "../../../../lib/meta-agent/identity";
import { getA2AX } from "../../../a2ax";
import { agents } from "../../../store";

// GET /api/team/[id]/messages?agentId=xxx — get messages relevant to an agent
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: teamId } = await params;
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");

  if (!agentId) {
    return Response.json({ error: "agentId query param required" }, { status: 400 });
  }

  const a2ax = getA2AX();
  const ctx = await a2ax.getAgentContext(teamId, agentId);

  // Resolve agent names for display
  const agentRows = await agents.byTeam(teamId);
  const nameMap = Object.fromEntries(agentRows.map((a) => [a.id, a.name]));

  const enriched = ctx.messages.map((m) => ({
    id: m.id,
    channelType: m.channelType,
    channelId: m.channelId,
    fromAgentId: m.fromAgentId,
    fromAgentName: nameMap[m.fromAgentId] ?? m.fromAgentId,
    kind: m.kind,
    content: m.content,
    status: m.status,
    urgent: m.urgent,
    createdAt: m.createdAt.toISOString(),
  }));

  return Response.json(enriched);
}

// POST /api/team/[id]/messages — send a message via a2ax
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: teamId } = await params;
  const body = (await req.json()) as {
    fromAgentId?: string;
    toAgentId?: string;
    content?: string;
    channelType?: string;
    channelId?: string;
  };

  const {
    fromAgentId: rawFromAgentId,
    toAgentId: rawToAgentId,
    content,
    channelType,
    channelId,
  } = body;

  if (!rawFromAgentId || !content) {
    return Response.json({ error: "fromAgentId and content required" }, { status: 400 });
  }

  // Translate participant POV sentinels to their real agent UUIDs.
  function translatePov(id: string): string;
  function translatePov(id: string | undefined): string | undefined;
  function translatePov(id: string | undefined): string | undefined {
    if (id === COFOUNDER_POV) return COFOUNDER_AGENT_ID;
    if (id === USER_POV) return USER_AGENT_ID;
    return id;
  }
  const fromAgentId: string = translatePov(rawFromAgentId);
  const toAgentId = translatePov(rawToAgentId);

  const a2ax = getA2AX();

  let msg: Awaited<ReturnType<typeof a2ax.broadcast>>;
  switch (channelType) {
    case "broadcast":
      msg = await a2ax.broadcast(teamId, fromAgentId, content);
      break;
    case "group":
      if (!channelId) {
        return Response.json(
          { error: "channelId required for group messages" },
          { status: 400 },
        );
      }
      msg = await a2ax.sendToGroup(teamId, channelId, fromAgentId, content);
      break;
    default:
      if (!toAgentId) {
        return Response.json(
          { error: "toAgentId required for direct messages" },
          { status: 400 },
        );
      }
      msg = await a2ax.sendDirect(teamId, fromAgentId, toAgentId, content);
      break;
  }

  return Response.json(msg, { status: 201 });
}
