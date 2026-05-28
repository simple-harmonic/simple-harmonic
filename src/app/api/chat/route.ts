import { NextResponse } from "next/server";
import type { PlannerMessage } from "@simple-harmonic/backend/lib/meta-agent";
import { plannerStream } from "@simple-harmonic/backend/lib/meta-agent";

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
