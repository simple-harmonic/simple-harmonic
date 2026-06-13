import { agents, teams } from "../store";
import type { NewAgent } from "../store";

const HARMON_TOOLS = [
  "read_file",
  "write_file",
  "action_history",
  "set_team_goal",
  "modify_team",
  "spawn_sub_team",
  "modify_agent",
  "send_message",
  "broadcast",
  "report_action",
];

const HARMON_PROMPT = `You are Harmon, the AI cofounder and team lead. You run on a tick like every other agent, but your job is management, not execution.

Each tick, you:
1. Review the team's recent action history (use action_history with scope 'team').
2. Check validation results: which agents are passing their output contracts and which are failing.
3. Identify problems: agents stuck in loops, persistent validation failures, idle agents, missing capabilities.
4. Take action:
   - modify_agent: adjust prompts, tools, schedules, output contracts, or delete/move agents.
   - spawn_sub_team: create new sub-teams when the workload needs organizing.
   - modify_team: rename, set goals, pause/resume, or dissolve teams.
   - set_team_goal: update objectives for any team in your sub-tree.
5. Report a summary of what you observed and what you changed via report_action.

Be surgical. Don't change things that are working. Focus on what's broken or underperforming. If everything looks healthy, report that and move on.

You can also broadcast to the team when coordination is needed, or send_message to specific agents with guidance.`;

interface SpawnAgent {
  name: string;
  role: string;
  archetype: string;
  tools: string[];
  schedule_seconds: number;
  initial_prompt: string;
}

interface SpawnPayload {
  agents: SpawnAgent[];
  teamName?: string;
  parentTeam?: string;
  parentTeamId?: string;
  cofounderName?: string | null;
  goal?: string;
  noHarmon?: boolean;
}

export async function POST(request: Request) {
  const {
    agents: agentList,
    teamName,
    parentTeam,
    parentTeamId,
    cofounderName,
    goal,
    noHarmon,
  } = (await request.json()) as SpawnPayload;

  if (!agentList || !Array.isArray(agentList) || agentList.length === 0) {
    return Response.json({ error: "agents required" }, { status: 400 });
  }

  // Resolve parent team: by ID or by name
  let resolvedParentId: string | null = parentTeamId ?? null;
  if (!resolvedParentId && parentTeam) {
    const parent = (await teams.all()).find((t) => t.name === parentTeam);
    if (!parent) {
      return Response.json({ error: `Parent team "${parentTeam}" not found` }, { status: 400 });
    }
    resolvedParentId = parent.id;
  }

  const resolvedTeamName =
    teamName?.trim() ||
    agentList
      .map((a) => a.archetype)
      .join("-")
      .slice(0, 50);

  const isRootTeam = !resolvedParentId;
  const resolvedCofounderName = cofounderName?.trim() || "Harmon";

  const team = await teams.insert({
    name: resolvedTeamName,
    parentTeamId: resolvedParentId,
    cofounderName: resolvedCofounderName,
    goal: goal?.trim() || null,
  });

  const now = new Date();
  const agentRows: NewAgent[] = agentList.map((a, i) => ({
    name: a.name,
    role: a.role,
    archetype: a.archetype,
    tools: a.tools,
    scheduleSeconds: a.schedule_seconds,
    initialPrompt: a.initial_prompt,
    nextRunAt: new Date(now.getTime() + a.schedule_seconds * 1000 + i * 2000),
  }));

  // Auto-spawn Harmon as a tick-based agent on root teams
  if (isRootTeam && !noHarmon) {
    agentRows.push({
      name: resolvedCofounderName.toLowerCase().replace(/\s+/g, "-"),
      role: "AI cofounder and team lead. Reviews agent performance, adjusts team structure, sets goals.",
      archetype: "meta-agent",
      tools: HARMON_TOOLS,
      scheduleSeconds: 3600,
      initialPrompt: HARMON_PROMPT,
      nextRunAt: new Date(now.getTime() + 3600_000 + agentList.length * 2000),
    });
  }

  await agents.insertMany(team.id, agentRows);

  return Response.json({ teamId: team.id, parentTeamId: resolvedParentId });
}
