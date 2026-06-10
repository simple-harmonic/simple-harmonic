import { db } from "@simple-harmonic/backend/server/db";
import { agentTraceEvents } from "@simple-harmonic/backend/server/db/schema";
import { and, asc, desc, eq, gte, type SQL } from "drizzle-orm";

// SSE: streams play-by-play trace events (one per agent step) for a team.
// Optional query params narrow the stream: ?agentId=<uuid> for one agent's
// steps, ?tickId=<uuid> for one tick thread. Emits a "history" event on
// connect (last HISTORY_LIMIT steps, chronological), then "update" events
// with only-new steps every 2s. Mirrors the narration route's lifecycle.
//
// New-step detection uses emittedAt >= lastSeen plus an id dedupe set rather
// than a strict >, because several steps can share one millisecond and a
// strict > would drop same-ms stragglers that persist slightly later.

const HISTORY_LIMIT = 200;
const UPDATE_LIMIT = 200;
const POLL_MS = 2000;
const SENT_IDS_CAP = 1000;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: teamId } = await params;
  const url = new URL(req.url);
  const agentId = url.searchParams.get("agentId");
  const tickId = url.searchParams.get("tickId");
  const d = db();

  const filters: SQL[] = [eq(agentTraceEvents.teamId, teamId)];
  if (agentId) filters.push(eq(agentTraceEvents.agentId, agentId));
  if (tickId) filters.push(eq(agentTraceEvents.tickId, tickId));
  const baseFilter = and(...filters);

  const encoder = new TextEncoder();
  let closed = false;
  let interval: ReturnType<typeof setInterval> | null = null;
  let lastSeen: Date | null = null;
  // Ids already emitted, to dedupe the >= poll window. FIFO-capped.
  const sentIds = new Set<string>();
  const sentOrder: string[] = [];

  const remember = (id: string) => {
    sentIds.add(id);
    sentOrder.push(id);
    while (sentOrder.length > SENT_IDS_CAP) {
      const oldest = sentOrder.shift();
      if (oldest) sentIds.delete(oldest);
    }
  };

  const stream = new ReadableStream({
    async start(controller) {
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Controller closed between the guard and the enqueue (race).
          closed = true;
          if (interval) clearInterval(interval);
        }
      };

      // 1. History: newest HISTORY_LIMIT steps, reversed to chronological.
      const history = await d.query.agentTraceEvents.findMany({
        where: baseFilter,
        orderBy: [desc(agentTraceEvents.emittedAt), desc(agentTraceEvents.seq)],
        limit: HISTORY_LIMIT,
      });
      const ordered = history.slice().reverse();
      for (const e of ordered) remember(e.id);
      if (ordered.length > 0) {
        lastSeen = ordered[ordered.length - 1].emittedAt;
      }
      safeEnqueue(`data: ${JSON.stringify({ type: "history", entries: ordered })}\n\n`);

      // 2. Live updates: poll for steps at/after lastSeen, dedupe by id.
      interval = setInterval(async () => {
        if (closed) return;
        try {
          const latest = await d.query.agentTraceEvents.findMany({
            where: lastSeen
              ? and(baseFilter, gte(agentTraceEvents.emittedAt, lastSeen))
              : baseFilter,
            orderBy: [asc(agentTraceEvents.emittedAt), asc(agentTraceEvents.seq)],
            limit: UPDATE_LIMIT,
          });
          const fresh = latest.filter((e) => !sentIds.has(e.id));
          if (fresh.length === 0) return;
          for (const e of fresh) remember(e.id);
          lastSeen = fresh[fresh.length - 1].emittedAt;
          safeEnqueue(`data: ${JSON.stringify({ type: "update", entries: fresh })}\n\n`);
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
      }, POLL_MS);
    },
    cancel() {
      // Client disconnected. Stop polling so we don't enqueue on a dead controller.
      closed = true;
      if (interval) clearInterval(interval);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Disable proxy buffering (nginx, Vercel) for live streaming.
      "X-Accel-Buffering": "no",
    },
  });
}
