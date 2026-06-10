// Play-by-play trace helpers shared by the trace views (agent POV trace tab,
// team activity play-by-play). Pure data shaping — no React.
//
// The SSE route (/api/team/[id]/trace) streams raw agent_trace_events rows.
// buildTickThreads() turns the flat event list into per-tick threads with
// human-readable steps, pairing request/response and started/finished events
// into single rows (an unpaired "started" renders as a live, in-flight step).

export interface TraceEvent {
  id: string;
  agentId: string;
  tickId: string;
  seq: number;
  type: string;
  data: Record<string, unknown>;
  emittedAt: string;
}

export type TickStatus = "live" | "finished" | "failed" | "awaiting_approval";

export interface TraceStepRow {
  /** Stable key for React lists (id of the originating event). */
  id: string;
  kind:
    | "tick_started"
    | "llm"
    | "tool"
    | "approval_requested"
    | "decision_applied"
    | "tick_finished"
    | "tick_failed"
    | "unknown";
  glyph: string;
  /** One-line summary, e.g. `read_file(notes.txt)` or `thought: "..."`. */
  label: string;
  /** Multi-line expandable detail (tool args/result, full thought). */
  detail?: string;
  timestamp: string;
  durationMs?: number;
  /** True while the step has started but not finished (renders pulsing). */
  live: boolean;
}

export interface TickThread {
  tickId: string;
  agentId: string;
  startedAt: string;
  status: TickStatus;
  /** Summary of the terminal step, e.g. "multi_action · 3 actions · 12.4s". */
  outcome?: string;
  steps: TraceStepRow[];
}

function truncate(s: string | undefined | null, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function fmtDuration(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function compactArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  if (typeof args === "string") return truncate(args, 80);
  try {
    const json = JSON.stringify(args);
    return truncate(json, 80);
  } catch {
    return String(args);
  }
}

function pretty(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Order events chronologically. seq breaks same-millisecond ties within one
 *  runner invocation; a resumed tick has a later emittedAt, so this is total. */
export function sortTraceEvents(events: TraceEvent[]): TraceEvent[] {
  return events.slice().sort((a, b) => {
    const ta = new Date(a.emittedAt).getTime();
    const tb = new Date(b.emittedAt).getTime();
    if (ta !== tb) return ta - tb;
    return a.seq - b.seq;
  });
}

/** Group a flat (already deduped) event list into per-tick threads, oldest
 *  tick first, with paired step rows ready to render. */
export function buildTickThreads(events: TraceEvent[]): TickThread[] {
  const sorted = sortTraceEvents(events);
  const byTick = new Map<string, TraceEvent[]>();
  for (const e of sorted) {
    const list = byTick.get(e.tickId);
    if (list) list.push(e);
    else byTick.set(e.tickId, [e]);
  }

  const threads: TickThread[] = [];
  for (const [tickId, list] of byTick) {
    threads.push(buildThread(tickId, list));
  }
  threads.sort((a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime());
  return threads;
}

function buildThread(tickId: string, events: TraceEvent[]): TickThread {
  const steps: TraceStepRow[] = [];
  // Pending (started-but-unfinished) rows, so finish events merge into them.
  let pendingLLM: TraceStepRow | null = null;
  const pendingTools = new Map<string, TraceStepRow>();

  for (const e of events) {
    const d = e.data ?? {};
    switch (e.type) {
      case "tick_started": {
        const resume = d.mode === "resume";
        steps.push({
          id: e.id,
          kind: "tick_started",
          glyph: resume ? "↻" : "▶",
          label: resume ? "resumed after approval" : "tick started",
          timestamp: e.emittedAt,
          live: false,
        });
        break;
      }
      case "llm_request": {
        const row: TraceStepRow = {
          id: e.id,
          kind: "llm",
          glyph: "✻",
          label: `thinking… (${d.model ?? "model"}, round ${(d.round as number) ?? 0})`,
          timestamp: e.emittedAt,
          live: true,
        };
        steps.push(row);
        pendingLLM = row;
        break;
      }
      case "llm_response": {
        const thought = typeof d.thought === "string" && d.thought.trim() ? d.thought : null;
        const toolCalls = Array.isArray(d.toolCalls)
          ? (d.toolCalls as Array<{ tool?: string }>).map((t) => t.tool).filter(Boolean)
          : [];
        const label = thought
          ? `“${truncate(thought, 110)}”`
          : toolCalls.length > 0
            ? `decided: ${toolCalls.join(", ")}`
            : "(empty response)";
        const row = pendingLLM ?? {
          id: e.id,
          kind: "llm" as const,
          glyph: "✻",
          label: "",
          timestamp: e.emittedAt,
          live: false,
        };
        row.label = label;
        row.detail = thought && thought.length > 110 ? thought : undefined;
        row.durationMs = typeof d.durationMs === "number" ? d.durationMs : undefined;
        row.live = false;
        if (!pendingLLM) steps.push(row);
        pendingLLM = null;
        break;
      }
      case "tool_started": {
        const tool = String(d.tool ?? "tool");
        const row: TraceStepRow = {
          id: e.id,
          kind: "tool",
          glyph: "⏺",
          label: `${tool}(${compactArgs(d.args)})`,
          detail: pretty(d.args) || undefined,
          timestamp: e.emittedAt,
          live: true,
        };
        steps.push(row);
        if (typeof d.toolCallId === "string") pendingTools.set(d.toolCallId, row);
        break;
      }
      case "tool_finished": {
        const callId = typeof d.toolCallId === "string" ? d.toolCallId : "";
        const row = pendingTools.get(callId);
        const failed = typeof d.error === "string";
        const outcome = failed ? `failed: ${d.error}` : String(d.result ?? "");
        if (row) {
          row.live = false;
          row.durationMs = typeof d.durationMs === "number" ? d.durationMs : undefined;
          row.detail = [row.detail, outcome ? `→ ${outcome}` : ""].filter(Boolean).join("\n\n");
          if (failed) row.glyph = "⊗";
          pendingTools.delete(callId);
        } else {
          steps.push({
            id: e.id,
            kind: "tool",
            glyph: failed ? "⊗" : "⏺",
            label: `${String(d.tool ?? "tool")} → ${truncate(outcome, 80)}`,
            detail: outcome || undefined,
            timestamp: e.emittedAt,
            durationMs: typeof d.durationMs === "number" ? d.durationMs : undefined,
            live: false,
          });
        }
        break;
      }
      case "approval_requested": {
        const pending = Array.isArray(d.pending)
          ? (d.pending as Array<{ tool?: string }>).map((p) => p.tool).filter(Boolean)
          : [];
        steps.push({
          id: e.id,
          kind: "approval_requested",
          glyph: "⏸",
          label: `paused — needs approval: ${pending.join(", ") || "destructive action"}`,
          detail: pretty(d.pending) || undefined,
          timestamp: e.emittedAt,
          live: false,
        });
        break;
      }
      case "decision_applied": {
        const approved = d.approved === true;
        steps.push({
          id: e.id,
          kind: "decision_applied",
          glyph: approved ? "✓" : "✗",
          label: `${approved ? "you approved" : "you rejected"} ${d.tool ?? "the action"}${
            d.note ? ` — “${truncate(String(d.note), 60)}”` : ""
          }`,
          timestamp: e.emittedAt,
          live: false,
        });
        break;
      }
      case "tick_finished": {
        const validation = d.validation as { valid?: boolean } | undefined;
        const parts = [
          String(d.actionType ?? "done"),
          `${(d.actionCount as number) ?? 0} action${d.actionCount === 1 ? "" : "s"}`,
          fmtDuration(d.durationMs as number | undefined),
        ].filter(Boolean);
        if (validation) parts.push(validation.valid ? "contract ✓" : "contract ✗");
        steps.push({
          id: e.id,
          kind: "tick_finished",
          glyph: "■",
          label: parts.join(" · "),
          timestamp: e.emittedAt,
          live: false,
        });
        break;
      }
      case "tick_failed": {
        steps.push({
          id: e.id,
          kind: "tick_failed",
          glyph: "⊗",
          label: `tick failed (${d.phase ?? "tick"}): ${truncate(String(d.error ?? "unknown error"), 120)}`,
          detail: typeof d.error === "string" && d.error.length > 120 ? d.error : undefined,
          timestamp: e.emittedAt,
          live: false,
        });
        break;
      }
      default: {
        steps.push({
          id: e.id,
          kind: "unknown",
          glyph: "•",
          label: e.type.replace(/_/g, " "),
          detail: pretty(d) || undefined,
          timestamp: e.emittedAt,
          live: false,
        });
      }
    }
  }

  const last = events[events.length - 1];
  let status: TickStatus = "live";
  let outcome: string | undefined;
  if (last?.type === "tick_finished") {
    status = "finished";
    outcome = steps[steps.length - 1]?.label;
  } else if (last?.type === "tick_failed") {
    status = "failed";
    outcome = steps[steps.length - 1]?.label;
  } else if (last?.type === "approval_requested") {
    status = "awaiting_approval";
    outcome = "waiting for your decision";
  }

  return {
    tickId,
    agentId: events[0]?.agentId ?? "",
    startedAt: events[0]?.emittedAt ?? new Date(0).toISOString(),
    status,
    outcome,
    steps,
  };
}
