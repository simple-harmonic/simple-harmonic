import { agents, teams } from "../../store";
import { createAppRegistry } from "../../tools";

interface SkillInfo {
  name: string;
  description: string;
  category: string;
  risk: string;
  agentCount: number;
  agents: Array<{ id: string; name: string; teamName: string }>;
}

export async function GET() {
  const registry = createAppRegistry();
  const allDefs = registry.listForAgent();

  let allAgents: Array<{ id: string; name: string; teamId: string; tools: unknown }> = [];
  let teamMap = new Map<string, string>();

  try {
    allAgents = await agents.all();
    const allTeams = await teams.all();
    teamMap = new Map(allTeams.map((t) => [t.id, t.name]));
  } catch {
    // store unavailable: still return tool definitions without agent assignments
  }

  const skills: SkillInfo[] = allDefs.map((def) => {
    const using = allAgents.filter((a) => {
      const tools = a.tools as string[];
      return tools.includes(def.name);
    });
    return {
      name: def.name,
      description: def.description,
      category: def.category,
      risk: def.risk,
      agentCount: using.length,
      agents: using.map((a) => ({
        id: a.id,
        name: a.name,
        teamName: teamMap.get(a.teamId) ?? "Unknown",
      })),
    };
  });

  return Response.json({ skills });
}

export async function PATCH(req: Request) {
  const body = await req.json();
  const { agentId, tools } = body as { agentId: string; tools: string[] };

  if (!agentId || !Array.isArray(tools)) {
    return Response.json({ error: "agentId and tools[] required" }, { status: 400 });
  }

  const registry = createAppRegistry();
  const validNames = new Set(registry.listForAgent().map((d) => d.name));
  const invalid = tools.filter((t) => !validNames.has(t));
  if (invalid.length > 0) {
    return Response.json({ error: `Unknown tools: ${invalid.join(", ")}` }, { status: 400 });
  }

  const updated = await agents.update(agentId, { tools });

  if (!updated) {
    return Response.json({ error: "Agent not found" }, { status: 404 });
  }

  return Response.json({ ok: true, agent: { id: updated.id, tools: updated.tools } });
}
