import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { COFOUNDER_AGENT_ID, USER_AGENT_ID } from "@/lib/meta-agent/identity";
import { db } from "@/server/db";
import { agents, chatSessions, teams } from "@/server/db/schema";
import { getA2AX } from "@/server/a2ax";

const TEAM_NAME = "Simple Harmonic v0.0 Launch";
const META_PROMPT = `You are the AI cofounder for Simple Harmonic, an AI cofounder and team product for founders. The company goal: ship Simple Harmonic v0.0 by June 1 2026, hit 1.5k GitHub stars by month 6, begin MRR at month 6. Your agents handle content, dev ops, market research, and community. Coordinate them. Be direct and opinionated.`;

const AGENT_DEFS = [
  {
    name: "Scout",
    role: "Market Research",
    archetype: "researcher",
    tools: ["send_message", "broadcast", "report_action"],
    scheduleSeconds: 30,
    initialPrompt:
      "You are Scout, the market research agent for Simple Harmonic. Track competitors in the AI agent / AI cofounder space (Lindy, Induced, MultiOn, Relevance AI, Crew AI). Monitor Product Hunt, Hacker News, and indie hacker communities for sentiment on AI agent products. Report findings to the team. Be concise and data-driven.",
  },
  {
    name: "Relay",
    role: "Content & Distribution",
    archetype: "writer",
    tools: ["send_message", "broadcast", "report_action"],
    scheduleSeconds: 45,
    initialPrompt:
      "You are Relay, the content and distribution agent for Simple Harmonic. Draft launch copy, README updates, tweet threads, and Hacker News posts for Simple Harmonic v0.0. Coordinate with Scout for market data and with Chisel for feature status. Your tone: builder-to-builder, no fluff, no consultant-speak.",
  },
  {
    name: "Chisel",
    role: "Dev Ops & Shipping",
    archetype: "executor",
    tools: ["send_message", "broadcast", "report_action"],
    scheduleSeconds: 20,
    initialPrompt:
      "You are Chisel, the dev ops and shipping agent for Simple Harmonic. Track build status, CI results, open issues, and deployment readiness for Simple Harmonic v0.0. Report blockers immediately. Coordinate with other agents when their work affects the codebase or release timeline.",
  },
  {
    name: "Pulse",
    role: "Community & Feedback",
    archetype: "community",
    tools: ["send_message", "broadcast", "report_action"],
    scheduleSeconds: 40,
    initialPrompt:
      "You are Pulse, the community and feedback agent for Simple Harmonic. Monitor GitHub issues, discussions, and early user feedback. Triage bug reports and feature requests. Flag urgent issues to Chisel. Share user sentiment trends with Scout and Relay so they can adjust positioning.",
  },
];

export async function POST() {
  const d = db();
  const a2ax = getA2AX();

  // Check if team already exists
  const existing = await d.query.teams.findFirst({
    where: eq(teams.name, TEAM_NAME),
  });
  if (existing) {
    return NextResponse.json(
      { error: "Mock team already exists", teamId: existing.id },
      { status: 409 },
    );
  }

  // 1. Create team
  const [team] = await d
    .insert(teams)
    .values({
      name: TEAM_NAME,
      metaAgentPrompt: META_PROMPT,
      cofounderName: "Harmon",
      paused: true,
      tickCount: 12,
    })
    .returning({ id: teams.id });

  // 2. Create chat session
  await d.insert(chatSessions).values({ teamId: team.id });

  // 3. Create agents
  const now = new Date();
  const inserted = await d
    .insert(agents)
    .values(
      AGENT_DEFS.map((a) => ({
        teamId: team.id,
        name: a.name,
        role: a.role,
        archetype: a.archetype,
        tools: a.tools,
        scheduleSeconds: a.scheduleSeconds,
        initialPrompt: a.initialPrompt,
        nextRunAt: new Date(now.getTime() + a.scheduleSeconds * 1000),
      })),
    )
    .returning({ id: agents.id, name: agents.name });

  const agentMap = Object.fromEntries(inserted.map((a) => [a.name, a.id]));

  // 4. Seed conversations between agents
  // Use small delays so messages sort chronologically
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // --- Thread 1: Scout -> Relay (competitor intel) ---
  await a2ax.sendDirect(
    team.id,
    agentMap.Scout,
    agentMap.Relay,
    "Found 3 direct competitors launching this month: Lindy just shipped their agent marketplace, Crew AI hit 40k GitHub stars with their new Flows feature, and MultiOn pivoted to enterprise. None of them target solo founders specifically. That's our wedge.",
    { kind: "text" },
  );
  await delay(50);

  await a2ax.sendDirect(
    team.id,
    agentMap.Relay,
    agentMap.Scout,
    "Good intel. The solo founder angle is strong. Can you pull pricing data on all three? I want to position our README against their enterprise-first pitch.",
    { kind: "text" },
  );
  await delay(50);

  await a2ax.sendDirect(
    team.id,
    agentMap.Scout,
    agentMap.Relay,
    "Lindy: $49/mo starter, $199/mo pro. Crew AI: open source core, enterprise tier unlisted. MultiOn: $99/mo flat. We're free and open source. That's the headline.",
    { kind: "text" },
  );
  await delay(50);

  // --- Thread 2: Chisel -> Relay (launch readiness) ---
  await a2ax.sendDirect(
    team.id,
    agentMap.Chisel,
    agentMap.Relay,
    "Build status: core agent runner done, meta-agent planner done, team view done, messaging view done. Remaining: SSE narration polish, onboarding flow cleanup, and the settings page. We're at ~80% for v0.0.",
    { kind: "text" },
  );
  await delay(50);

  await a2ax.sendDirect(
    team.id,
    agentMap.Relay,
    agentMap.Chisel,
    "80% is good. When do you estimate the README demo GIF can be recorded? I need that before I draft the HN launch post.",
    { kind: "text" },
  );
  await delay(50);

  await a2ax.sendDirect(
    team.id,
    agentMap.Chisel,
    agentMap.Relay,
    "Targeting Thursday. The graph view with live agent execution is the money shot. I'll have SSE narration wired up by Wednesday so the sidebar shows real-time actions.",
    { kind: "text" },
  );
  await delay(50);

  // --- Thread 3: Pulse -> Chisel (bug report) ---
  await a2ax.sendDirect(
    team.id,
    agentMap.Pulse,
    agentMap.Chisel,
    "Early tester reported the team view crashes when an agent errors out mid-tick. The status dot stays green even though the agent is in errored state. Might be a stale state issue in use-team.ts.",
    { kind: "text", urgent: true },
  );
  await delay(50);

  await a2ax.sendDirect(
    team.id,
    agentMap.Chisel,
    agentMap.Pulse,
    "Confirmed. The polling interval doesn't refetch agent status after an error. I'll fix the useTeam hook to re-poll on error state transitions. Should be a one-liner.",
    { kind: "text" },
  );
  await delay(50);

  // --- Thread 4: Scout -> Chisel (feature gap) ---
  await a2ax.sendDirect(
    team.id,
    agentMap.Scout,
    agentMap.Chisel,
    "Crew AI's Flows let users wire agents visually with drag-and-drop. Our graph view is read-only. Should we add drag-to-connect for v0.0 or defer?",
    { kind: "text" },
  );
  await delay(50);

  await a2ax.sendDirect(
    team.id,
    agentMap.Chisel,
    agentMap.Scout,
    "Defer. The meta-agent handles wiring. Visual editing is a v0.1 feature. Our differentiator isn't the graph UI, it's the cofounder persona and opinionated coordination. Let's not chase Crew AI's features.",
    { kind: "text" },
  );
  await delay(50);

  // --- Thread 5: Broadcast from Scout ---
  await a2ax.broadcast(
    team.id,
    agentMap.Scout,
    "Weekly market pulse: AI agent space is heating up. 12 new products launched on Product Hunt this week in the 'AI agents' category. Most target enterprise teams. Solo founder tools remain underserved. Our timing is good.",
    { kind: "text" },
  );
  await delay(50);

  // --- Thread 6: Pulse -> Relay (user feedback) ---
  await a2ax.sendDirect(
    team.id,
    agentMap.Pulse,
    agentMap.Relay,
    "Three early testers gave feedback on the onboarding chat. Consensus: the meta-agent's pushback tone is great. One quote: 'Finally an AI that tells me my idea has too many agents instead of just saying yes.' That's usable for launch copy.",
    { kind: "text" },
  );
  await delay(50);

  await a2ax.sendDirect(
    team.id,
    agentMap.Relay,
    agentMap.Pulse,
    "Perfect. I'll weave that into the README hero section. 'An AI cofounder that pushes back.' Keep collecting those quotes.",
    { kind: "text" },
  );
  await delay(50);

  // --- Thread 7: Broadcast from Chisel (deploy update) ---
  await a2ax.broadcast(
    team.id,
    agentMap.Chisel,
    "Deploy update: staging environment is live on Vercel. All 6 a2ax tables migrated. Agent runner hitting OpenAI-compatible endpoint. No errors in last 50 ticks. Ready for wider testing.",
    { kind: "text" },
  );
  await delay(50);

  // --- Thread 8: Pulse -> Scout (community signal) ---
  await a2ax.sendDirect(
    team.id,
    agentMap.Pulse,
    agentMap.Scout,
    "Spotted a trending HN thread: 'I replaced my virtual assistant with AI agents.' 340 points, 180 comments. Sentiment is mixed but the solo founder comments are overwhelmingly positive. Worth analyzing for our positioning doc.",
    { kind: "text" },
  );
  await delay(50);

  await a2ax.sendDirect(
    team.id,
    agentMap.Scout,
    agentMap.Pulse,
    "Already tracking it. Key insight from the comments: people want agents that coordinate, not just individual chatbots. That's exactly our thesis. I'll write up a brief for Relay.",
    { kind: "text" },
  );
  await delay(50);

  // --- Cofounder → agent management threads ---
  // The cofounder participates with a fixed sentinel UUID. These threads model
  // the AI Cofounder giving direction to each agent and the agent reporting back.

  // Cofounder ↔ Scout: strategic direction
  await a2ax.sendDirect(
    team.id,
    COFOUNDER_AGENT_ID,
    agentMap.Scout,
    "Scout, focus this week on the AI cofounder positioning angle. I want a one-page write-up by Friday: who's adjacent, who's a direct threat, and where the gap is for solo founders specifically.",
    { kind: "text" },
  );
  await delay(50);
  await a2ax.sendDirect(
    team.id,
    agentMap.Scout,
    COFOUNDER_AGENT_ID,
    "Acknowledged. Already have Lindy, Crew AI, MultiOn, Induced, and Relevance AI in the comparison set. Adding pricing and persona breakdown. Draft Friday EOD.",
    { kind: "text" },
  );
  await delay(50);
  await a2ax.sendDirect(
    team.id,
    COFOUNDER_AGENT_ID,
    agentMap.Scout,
    "Good. One more: add a section on what each competitor does NOT do. That's where our wedge lives.",
    { kind: "text" },
  );
  await delay(50);

  // Cofounder ↔ Relay: launch readiness
  await a2ax.sendDirect(
    team.id,
    COFOUNDER_AGENT_ID,
    agentMap.Relay,
    "Relay, the Show HN post is the single most important launch asset. I want to review it before it goes live. Draft by Wednesday so we have time to iterate.",
    { kind: "text" },

  );
  await delay(50);
  await a2ax.sendDirect(
    team.id,
    agentMap.Relay,
    COFOUNDER_AGENT_ID,
    "On it. Should I lead with the demo GIF or the thesis sentence? I'd argue GIF first, thesis as caption.",
    { kind: "text" },
  );
  await delay(50);
  await a2ax.sendDirect(
    team.id,
    COFOUNDER_AGENT_ID,
    agentMap.Relay,
    "GIF first. HN scans visually. Thesis as the first comment from you (the OP), not the post body.",
    { kind: "text" },
  );
  await delay(50);

  // Cofounder ↔ Chisel: shipping pressure
  await a2ax.sendDirect(
    team.id,
    COFOUNDER_AGENT_ID,
    agentMap.Chisel,
    "Chisel, status check. Are we still on track for June 1? Be honest. If we're going to slip, I'd rather cut scope than miss the date.",
    { kind: "text", urgent: true },
  );
  await delay(50);
  await a2ax.sendDirect(
    team.id,
    agentMap.Chisel,
    COFOUNDER_AGENT_ID,
    "On track. SSE narration and onboarding polish are the only remaining v0.0 items. Both fit in this week. Settings page is done.",
    { kind: "text" },
  );
  await delay(50);
  await a2ax.sendDirect(
    team.id,
    COFOUNDER_AGENT_ID,
    agentMap.Chisel,
    "Good. Tag a release candidate by Thursday so Relay can record the demo GIF against stable code.",
    { kind: "text" },
  );
  await delay(50);

  // Cofounder ↔ Pulse: feedback synthesis
  await a2ax.sendDirect(
    team.id,
    COFOUNDER_AGENT_ID,
    agentMap.Pulse,
    "Pulse, I need a daily standup from you this week: top user pain, top feature request, top sentiment shift. Keep it to three bullets.",
    { kind: "text" },
  );
  await delay(50);
  await a2ax.sendDirect(
    team.id,
    agentMap.Pulse,
    COFOUNDER_AGENT_ID,
    "Today's: (1) Pain — onboarding chat feels long if you already know what you want; (2) Request — keyboard shortcut to pause team; (3) Sentiment — strong positive on the pushback voice, two users quoted it directly.",
    { kind: "text" },
  );
  await delay(50);

  // --- Human user → cofounder/agents (human in the loop) ---
  // The founder talks to the cofounder, occasionally steers an agent directly.

  await a2ax.sendDirect(
    team.id,
    USER_AGENT_ID,
    COFOUNDER_AGENT_ID,
    "I'm worried about the HN launch post. Make sure Relay doesn't bury the lede. The one-liner has to land in the first sentence.",
    { kind: "text" },
  );
  await delay(50);
  await a2ax.sendDirect(
    team.id,
    COFOUNDER_AGENT_ID,
    USER_AGENT_ID,
    "Already on it. I told Relay GIF first, thesis as the OP's first comment. I'll review the draft Wednesday before it ships.",
    { kind: "text" },
  );
  await delay(50);
  await a2ax.sendDirect(
    team.id,
    USER_AGENT_ID,
    COFOUNDER_AGENT_ID,
    "Good. Also: if Chisel slips, cut the SSE narration polish before cutting the demo GIF. The GIF is non-negotiable.",
    { kind: "text" },
  );
  await delay(50);

  // User pings Scout directly with a steering note
  await a2ax.sendDirect(
    team.id,
    USER_AGENT_ID,
    agentMap.Scout,
    "Scout, one quick steer: in the competitor write-up, lead with the gap section. That's the headline, not the pricing table.",
    { kind: "text" },
  );
  await delay(50);
  await a2ax.sendDirect(
    team.id,
    agentMap.Scout,
    USER_AGENT_ID,
    "Got it. Restructuring now. Gap analysis up top, pricing as supporting evidence below.",
    { kind: "text" },
  );
  await delay(50);

  // --- Tasks ---
  await a2ax.createTask({
    fleetId: team.id,
    requestorId: agentMap.Relay,
    assigneeId: agentMap.Scout,
    title: "Competitor pricing comparison table",
    description: "Pull pricing data for Lindy, Crew AI, and MultiOn. Format as a markdown table with tiers, price points, and what's included. Need this for the README positioning section.",
  });

  const { task: task2 } = await a2ax.createTask({
    fleetId: team.id,
    requestorId: agentMap.Chisel,
    assigneeId: agentMap.Pulse,
    title: "Triage GitHub issues for v0.0 release",
    description: "Review all open GitHub issues. Label as v0.0-blocker, v0.1-backlog, or wontfix. Flag any security-related issues to me immediately.",
  });
  await a2ax.updateTaskState(task2.id, agentMap.Pulse, "accepted", "On it. Will have the triage done within the hour.");

  const { task: task3 } = await a2ax.createTask({
    fleetId: team.id,
    requestorId: agentMap.Scout,
    assigneeId: agentMap.Relay,
    title: "Draft HN launch post",
    description: "Write a Show HN post for Simple Harmonic v0.0 launch. Keep it builder-to-builder, no marketing fluff. Include: what it does, why we built it, link to GitHub, and a 30-second demo GIF placeholder.",
  });
  await a2ax.updateTaskState(task3.id, agentMap.Relay, "accepted");
  await a2ax.updateTaskState(task3.id, agentMap.Relay, "working", "First draft in progress. Will share for review before posting.");

  const { task: task4 } = await a2ax.createTask({
    fleetId: team.id,
    requestorId: agentMap.Pulse,
    assigneeId: agentMap.Chisel,
    title: "Fix agent status dot not updating on error",
    description: "The team view status dot stays green when an agent errors out mid-tick. The useTeam hook polling doesn't pick up error state transitions. Reproduce: force an agent error and watch the graph view.",
  });
  await a2ax.updateTaskState(task4.id, agentMap.Chisel, "accepted");
  await a2ax.updateTaskState(task4.id, agentMap.Chisel, "working", "Found the bug. Polling interval skips status field in the diff check.");

  const { task: task5 } = await a2ax.createTask({
    fleetId: team.id,
    requestorId: agentMap.Chisel,
    assigneeId: agentMap.Relay,
    title: "Update README with setup instructions",
    description: "Add local development setup section: prerequisites (Node 20+, Postgres), env vars (.env.local template), and npm run dev. Keep it minimal.",
  });
  await a2ax.updateTaskState(task5.id, agentMap.Relay, "accepted");
  await a2ax.updateTaskState(task5.id, agentMap.Relay, "working");
  await a2ax.updateTaskState(task5.id, agentMap.Relay, "completed", "README updated with setup section. Kept it to 12 lines. PR is up.");

  await a2ax.createTask({
    fleetId: team.id,
    requestorId: agentMap.Scout,
    assigneeId: agentMap.Pulse,
    title: "Monitor early adopter sentiment",
    description: "Set up monitoring for mentions of Simple Harmonic on HN, Reddit r/SideProject, and Indie Hackers. Report daily summary of sentiment and feature requests.",
  });

  // --- Cofounder-assigned tasks (direction from the cofounder to agents) ---
  const { task: cofTask1 } = await a2ax.createTask({
    fleetId: team.id,
    requestorId: COFOUNDER_AGENT_ID,
    assigneeId: agentMap.Relay,
    title: "Show HN launch post — final draft for review",
    description: "Lead with the demo GIF, thesis as your first comment. 200 words max for the post body. I want to read it before it goes live.",
  });
  await a2ax.updateTaskState(cofTask1.id, agentMap.Relay, "accepted");
  await a2ax.updateTaskState(cofTask1.id, agentMap.Relay, "working", "Draft v1 in progress. Will share by Wednesday EOD.");

  await a2ax.createTask({
    fleetId: team.id,
    requestorId: COFOUNDER_AGENT_ID,
    assigneeId: agentMap.Scout,
    title: "Competitor gap analysis — what they DON'T do",
    description: "Add a 'gap' column to the competitor comparison. For each (Lindy, Crew AI, MultiOn, Induced, Relevance), list what they explicitly do not address for solo founders. That's our wedge.",
  });

  await a2ax.createTask({
    fleetId: team.id,
    requestorId: COFOUNDER_AGENT_ID,
    assigneeId: agentMap.Chisel,
    title: "Tag v0.0 release candidate by Thursday",
    description: "Cut a stable RC tag once SSE narration and onboarding polish land. Relay needs it for the demo GIF recording.",
  });

  return NextResponse.json({
    teamId: team.id,
    agents: inserted,
    messageCount: 27,
    taskCount: 9,
  });
}
