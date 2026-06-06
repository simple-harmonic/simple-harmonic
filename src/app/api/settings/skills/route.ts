import { db } from "@simple-harmonic/backend/server/db";
import { agents } from "@simple-harmonic/backend/server/db/schema";
import { createAppRegistry } from "@simple-harmonic/backend/server/tools";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";

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
    const d = db();
    allAgents = await d.query.agents.findMany();
    const allTeams = await d.query.teams.findMany();
    teamMap = new Map(allTeams.map((t) => [t.id, t.name]));
  } catch {
    // DB unavailable: still return tool definitions without agent assignments
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

  return NextResponse.json({ skills });
}

export async function PATCH(req: Request) {
  const body = await req.json();
  const { agentId, tools } = body as { agentId: string; tools: string[] };

  if (!agentId || !Array.isArray(tools)) {
    return NextResponse.json({ error: "agentId and tools[] required" }, { status: 400 });
  }

  const registry = createAppRegistry();
  const validNames = new Set(registry.listForAgent().map((d) => d.name));
  const invalid = tools.filter((t) => !validNames.has(t));
  if (invalid.length > 0) {
    return NextResponse.json({ error: `Unknown tools: ${invalid.join(", ")}` }, { status: 400 });
  }

  const d = db();
  const updated = await d
    .update(agents)
    .set({ tools })
    .where(eq(agents.id, agentId))
    .returning({ id: agents.id, tools: agents.tools });

  if (updated.length === 0) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true, agent: updated[0] });
}
