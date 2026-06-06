// ---------------------------------------------------------------------------
// Seed a demo team that showcases every feature:
//   - Recursive teams (root + 2 sub-teams)
//   - Lead agent (engineering lead with spawn_sub_team + modify_agent)
//   - Output contracts on every agent
//   - Full tool coverage (coding_task, github_api, http_fetch, etc.)
//   - Custom API tool (mock httpbin)
//   - Connector (mock GITHUB_TOKEN)
//   - All archetypes represented
//
// Run: npx tsx scripts/seed-demo.ts
// ---------------------------------------------------------------------------

import { sql } from "drizzle-orm";
import { db } from "../packages/backend/src/server/db/index.js";
import { agents, teams, chatSessions, chatMessages, actionLog, pendingApprovals, a2axMessages, a2axChannels, a2axChannelMembers, a2axTasks } from "../packages/backend/src/server/db/schema.js";
import { saveConnector } from "../packages/backend/src/server/connectors.js";
import { saveCustomToolFile } from "../packages/backend/src/server/custom-tools.js";

async function main() {
  const d = db();

  // --- Clear everything ---
  console.log("Clearing existing data...");
  await d.delete(pendingApprovals);
  await d.delete(actionLog);
  await d.delete(a2axMessages);
  await d.delete(a2axChannelMembers);
  await d.delete(a2axTasks);
  await d.delete(a2axChannels);
  await d.delete(agents);
  await d.delete(chatMessages);
  await d.delete(chatSessions);
  await d.delete(teams);
  console.log("Cleared.");

  // --- Root team ---
  const [rootTeam] = await d.insert(teams).values({
    name: "Harmonic Labs",
    cofounderName: "Harmon",
    lastUserActiveAt: new Date(),
  }).returning();
  console.log("Root team:", rootTeam.name, rootTeam.id.slice(0, 8));

  await d.insert(chatSessions).values({ teamId: rootTeam.id });

  // --- Engineering sub-team ---
  const [engTeam] = await d.insert(teams).values({
    name: "Engineering",
    parentTeamId: rootTeam.id,
    lastUserActiveAt: new Date(),
  }).returning();
  console.log("Sub-team:", engTeam.name, engTeam.id.slice(0, 8));

  await d.insert(chatSessions).values({ teamId: engTeam.id });

  // --- Growth sub-team ---
  const [growthTeam] = await d.insert(teams).values({
    name: "Growth",
    parentTeamId: rootTeam.id,
    lastUserActiveAt: new Date(),
  }).returning();
  console.log("Sub-team:", growthTeam.name, growthTeam.id.slice(0, 8));

  await d.insert(chatSessions).values({ teamId: growthTeam.id });

  const now = new Date();

  // --- Engineering agents ---
  const engAgents = [
    {
      name: "eng-lead",
      role: "Engineering team lead. Coordinates sub-team, assigns work, reviews output.",
      archetype: "code-reviewer",
      tools: ["read_file", "write_file", "run_command", "coding_task", "github_api", "send_message", "broadcast", "report_action", "spawn_sub_team", "modify_agent"],
      scheduleSeconds: 300,
      initialPrompt: "You are the engineering team lead for Simple Harmonic. Review agent outputs, coordinate work, escalate blockers. You can spawn sub-teams and modify agents.",
      outputContract: {
        type: "object",
        required: ["status", "blockers"],
        properties: {
          status: { type: "string", description: "Team status summary" },
          blockers: { type: "array", items: { type: "object", required: ["description"], properties: { description: { type: "string" }, assignee: { type: "string" } } } },
          delegated: { type: "array", items: { type: "string" } },
        },
      },
    },
    {
      name: "bug-hunter",
      role: "Find bugs in the codebase. Report with file, line, severity, and description.",
      archetype: "bug-hunter",
      tools: ["read_file", "run_command", "coding_task", "http_fetch", "send_message", "report_action"],
      scheduleSeconds: 600,
      initialPrompt: "You hunt bugs in the Simple Harmonic codebase. Use read_file and run_command to investigate. Use coding_task for deep analysis. Report every bug you find via report_action with the exact structure from your output contract.",
      outputContract: {
        type: "object",
        required: ["bugs"],
        properties: {
          bugs: {
            type: "array",
            items: {
              type: "object",
              required: ["file", "description", "severity"],
              properties: {
                file: { type: "string" },
                line: { type: "number" },
                description: { type: "string" },
                severity: { type: "string" },
              },
            },
          },
        },
      },
    },
    {
      name: "test-runner",
      role: "Run the test suite, report results, fix failing tests.",
      archetype: "test-runner",
      tools: ["read_file", "run_command", "coding_task", "write_file", "send_message", "report_action"],
      scheduleSeconds: 600,
      initialPrompt: "You run the test suite for Simple Harmonic. Execute vitest, report pass/fail counts and specific failures. Use coding_task to fix broken tests. Always report results via report_action matching your output contract.",
      outputContract: {
        type: "object",
        required: ["passed", "failed"],
        properties: {
          passed: { type: "number" },
          failed: { type: "number" },
          total: { type: "number" },
          failures: {
            type: "array",
            items: {
              type: "object",
              required: ["test", "error"],
              properties: {
                test: { type: "string" },
                error: { type: "string" },
              },
            },
          },
        },
      },
    },
    {
      name: "docs-writer",
      role: "Keep documentation up to date with code changes.",
      archetype: "docs-writer",
      tools: ["read_file", "write_file", "coding_task", "run_command", "send_message", "report_action"],
      scheduleSeconds: 1800,
      initialPrompt: "You maintain documentation for Simple Harmonic. Check if docs match the code, update stale sections, write missing docs. Report what you updated via report_action.",
      outputContract: {
        type: "object",
        required: ["updated"],
        properties: {
          updated: {
            type: "array",
            items: {
              type: "object",
              required: ["file", "change"],
              properties: {
                file: { type: "string" },
                change: { type: "string" },
              },
            },
          },
        },
      },
    },
  ];

  for (let i = 0; i < engAgents.length; i++) {
    const a = engAgents[i];
    await d.insert(agents).values({
      teamId: engTeam.id,
      name: a.name,
      role: a.role,
      archetype: a.archetype,
      tools: a.tools,
      scheduleSeconds: a.scheduleSeconds,
      initialPrompt: a.initialPrompt,
      outputContract: a.outputContract,
      nextRunAt: new Date(now.getTime() + a.scheduleSeconds * 1000 + i * 2000),
    });
    console.log("  Agent:", a.name, `(${a.archetype})`, a.outputContract ? "with contract" : "");
  }

  // --- Growth agents ---
  const growthAgents = [
    {
      name: "content-scheduler",
      role: "Plan and schedule content across platforms.",
      archetype: "content-scheduler",
      tools: ["http_fetch", "send_message", "broadcast", "report_action"],
      scheduleSeconds: 600,
      initialPrompt: "You plan content for Simple Harmonic. Research trending topics, draft post ideas, schedule them. Report via report_action.",
      outputContract: {
        type: "object",
        required: ["posts"],
        properties: {
          posts: {
            type: "array",
            items: {
              type: "object",
              required: ["platform", "topic", "status"],
              properties: {
                platform: { type: "string" },
                topic: { type: "string" },
                status: { type: "string" },
              },
            },
          },
        },
      },
    },
    {
      name: "research-scout",
      role: "Research competitors, market trends, and user feedback.",
      archetype: "research-summarizer",
      tools: ["http_fetch", "send_message", "report_action"],
      scheduleSeconds: 1800,
      initialPrompt: "You research the competitive landscape for Simple Harmonic. Track AI agent platforms, developer tools, and founder tools. Report findings via report_action.",
      outputContract: {
        type: "object",
        required: ["findings"],
        properties: {
          findings: {
            type: "array",
            items: {
              type: "object",
              required: ["source", "summary"],
              properties: {
                source: { type: "string" },
                summary: { type: "string" },
                relevance: { type: "string" },
              },
            },
          },
        },
      },
    },
  ];

  for (let i = 0; i < growthAgents.length; i++) {
    const a = growthAgents[i];
    await d.insert(agents).values({
      teamId: growthTeam.id,
      name: a.name,
      role: a.role,
      archetype: a.archetype,
      tools: a.tools,
      scheduleSeconds: a.scheduleSeconds,
      initialPrompt: a.initialPrompt,
      outputContract: a.outputContract,
      nextRunAt: new Date(now.getTime() + a.scheduleSeconds * 1000 + i * 2000),
    });
    console.log("  Agent:", a.name, `(${a.archetype})`, "with contract");
  }

  // --- Custom API tool (httpbin for demo) ---
  saveCustomToolFile({
    name: "httpbin_api",
    description: "HTTPBin test API for demo purposes. Echoes requests back.",
    config: {
      baseUrl: "https://httpbin.org",
      connectorKey: "HTTPBIN_TOKEN",
      allowedMethods: ["GET", "POST"],
      authPrefix: "",
      authHeader: "X-Test-Auth",
    },
  });
  console.log("Custom tool: httpbin_api");

  // --- Connector (demo GitHub token) ---
  saveConnector(
    { name: "GitHub", description: "GitHub PAT for github_api tool", type: "api_key", key: "GITHUB_TOKEN" },
    process.env.GITHUB_TOKEN || "ghp_demo_placeholder",
  );
  console.log("Connector: GITHUB_TOKEN");

  // --- Summary ---
  const allTeams = await d.query.teams.findMany();
  const allAgents = await d.query.agents.findMany();

  console.log("\n=== Demo seeded ===");
  console.log(`Teams: ${allTeams.length} (1 root + 2 sub-teams)`);
  console.log(`Agents: ${allAgents.length}`);
  console.log(`  Engineering: ${allAgents.filter(a => a.teamId === engTeam.id).length} (eng-lead is a team lead)`);
  console.log(`  Growth: ${allAgents.filter(a => a.teamId === growthTeam.id).length}`);
  console.log(`Agents with output contracts: ${allAgents.filter(a => a.outputContract).length}`);
  console.log(`Lead agents: ${allAgents.filter(a => (a.tools as string[]).includes("spawn_sub_team")).length}`);

  const tree = allTeams.filter(t => !t.parentTeamId);
  for (const root of tree) {
    console.log(`\n${root.name}`);
    const children = allTeams.filter(t => t.parentTeamId === root.id);
    for (const child of children) {
      const childAgents = allAgents.filter(a => a.teamId === child.id);
      console.log(`  └─ ${child.name} (${childAgents.length} agents)`);
      for (const a of childAgents) {
        const isLead = (a.tools as string[]).includes("spawn_sub_team");
        const hasContract = !!a.outputContract;
        console.log(`     ${isLead ? "★" : "·"} ${a.name} (${a.archetype})${hasContract ? " [contract]" : ""}`);
      }
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
