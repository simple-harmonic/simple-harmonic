import { NextResponse } from "next/server";
import type { PlannerMessage, ModifyAgentResult } from "@simple-harmonic/backend/lib/meta-agent";
import { plannerStream } from "@simple-harmonic/backend/lib/meta-agent";
import { db } from "@simple-harmonic/backend/server/db";
import { agents, teams } from "@simple-harmonic/backend/server/db/schema";
import { and, eq } from "drizzle-orm";

async function applyModifyAgent(result: ModifyAgentResult): Promise<{ ok: boolean; error?: string }> {
  const d = db();

  const team = await d.query.teams.findFirst({
    where: eq(teams.name, result.team_name),
  });
  if (!team) return { ok: false, error: `Team "${result.team_name}" not found` };

  const agent = await d.query.agents.findFirst({
    where: and(eq(agents.teamId, team.id), eq(agents.name, result.agent_name)),
  });
  if (!agent) return { ok: false, error: `Agent "${result.agent_name}" not found in team "${result.team_name}"` };

  const set: Record<string, unknown> = {};
  const u = result.updates;
  if (u.tools !== undefined) set.tools = u.tools;
  if (u.initial_prompt !== undefined) set.initialPrompt = u.initial_prompt;
  if (u.schedule_seconds !== undefined) set.scheduleSeconds = u.schedule_seconds;
  if (u.role !== undefined) set.role = u.role;
  if (u.status !== undefined) set.status = u.status;

  if (Object.keys(set).length === 0) return { ok: false, error: "No updates provided" };

  await d.update(agents).set(set).where(eq(agents.id, agent.id));
  return { ok: true };
}

export async function POST(request: Request) {
  const { messages } = (await request.json()) as { messages: PlannerMessage[] };

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return NextResponse.json({ error: "messages required" }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const result = await plannerStream(messages, (token) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: "token", text: token })}\n\n`),
          );
        });

        if (result.type === "spawn") {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "spawn",
                agents: result.result.agents,
                teamName: result.result.team_name,
                cofounderName: result.result.cofounder_name ?? null,
                content: result.content,
              })}\n\n`,
            ),
          );
        } else if (result.type === "modify_agent") {
          const applied = await applyModifyAgent(result.result);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                type: "modify_agent",
                agentName: result.result.agent_name,
                teamName: result.result.team_name,
                updates: result.result.updates,
                applied,
                content: result.content,
              })}\n\n`,
            ),
          );
        } else {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "done", content: result.content })}\n\n`,
            ),
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: "error", message })}\n\n`),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
