import { actionLog, agents } from "../../../store";

// SSE: streams agent action log entries for a team. Emits one "history" event
// on connect (last 50), then "update" events with only-new entries every 3s.
// Cleans up reliably on client disconnect (cancel) by guarding the interval.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: teamId } = await params;

  // Get the agent ids in this team so we can filter the action log correctly.
  const teamAgents = await agents.byTeam(teamId);
  const agentIds = teamAgents.map((a) => a.id);

  // Edge case: no agents yet — return an empty stream that closes cleanly.
  if (agentIds.length === 0) {
    return new Response(`data: ${JSON.stringify({ type: "history", entries: [] })}\n\n`, {
      headers: sseHeaders(),
    });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  // Track the latest timestamp we've emitted so updates only send new entries.
  let lastSeen: Date | null = null;

  const stream = new ReadableStream({
    async start(controller) {
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller closed between the guard and the enqueue (race). Mark
          // closed so the interval stops trying.
          closed = true;
          if (interval) clearInterval(interval);
        }
      };

      // 1. History: last 50 entries for this team, oldest-first so the
      //    sidebar's "prepend new, slice 100" pattern displays in correct order.
      const history = await actionLog.byAgents(agentIds, { limit: 50 });
      // Reverse so chronological order is preserved in the client buffer.
      const orderedHistory = history.slice().reverse();
      if (orderedHistory.length > 0) {
        lastSeen = orderedHistory[orderedHistory.length - 1].executedAt;
      }
      safeEnqueue(`data: ${JSON.stringify({ type: "history", entries: orderedHistory })}\n\n`);

      // 2. Live updates: poll for new entries since lastSeen every 3s.
      interval = setInterval(async () => {
        if (closed) return;
        try {
          const latest = await actionLog.byAgents(agentIds, {
            limit: 20,
            since: lastSeen ?? undefined,
          });
          if (latest.length === 0) return;
          lastSeen = latest[0].executedAt;
          // Reverse so the client receives in chronological order.
          safeEnqueue(
            `data: ${JSON.stringify({ type: "update", entries: latest.slice().reverse() })}\n\n`,
          );
        } catch {
          // DB error — stop the loop rather than spam the controller.
          closed = true;
          if (interval) clearInterval(interval);
          try {
            controller.close();
          } catch {
            // already closed
          }
        }
      }, 3000);
    },
    cancel() {
      // Client disconnected. Stop polling so we don't enqueue on a dead controller.
      closed = true;
      if (interval) clearInterval(interval);
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // Disable proxy buffering (nginx, Vercel) for live streaming.
    "X-Accel-Buffering": "no",
  };
}
