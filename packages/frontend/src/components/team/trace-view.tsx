"use client";

// Play-by-play trace view: renders every agent step (LLM rounds, tool calls,
// approval pauses, decisions, tick boundaries) as live-updating tick threads.
// Used by the agent POV "trace" tab (one agent) and the team activity panel
// (all agents, pass no agentId). Subscribes to /api/team/[id]/trace SSE.

import { useEffect, useMemo, useRef, useState } from "react";
import type { TickStatus, TraceEvent, TraceStepRow } from "../../lib/trace";
import { buildTickThreads } from "../../lib/trace";

const MAX_EVENTS = 2000;

interface TraceViewProps {
  teamId: string;
  /** Limit the stream to one agent (agent POV tab). Omit for the whole team. */
  agentId?: string;
  /** id → display name, for labeling threads in team-wide mode. */
  agentNames?: Record<string, string>;
  /** Dense paddings for narrow containers (team sidebar). */
  compact?: boolean;
}

const STATUS_BADGE: Record<TickStatus, { label: string; cls: string }> = {
  live: { label: "live", cls: "text-running bg-running/10" },
  finished: { label: "done", cls: "text-fg-faint bg-border/40" },
  failed: { label: "failed", cls: "text-error bg-error/10" },
  awaiting_approval: { label: "needs approval", cls: "text-brand bg-brand/10" },
};

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  if (d.toDateString() === now.toDateString()) return time;
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${date} ${time}`;
}

function fmtDuration(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function TraceView({ teamId, agentId, agentNames, compact = false }: TraceViewProps) {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);

  useEffect(() => {
    setEvents([]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let cancelled = false;

    const qs = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
    fetch(`/api/team/${teamId}/trace${qs}`)
      .then(async (response) => {
        reader = response.body?.getReader();
        if (!reader) return;
        setConnected(true);

        const decoder = new TextDecoder();
        let buffer = "";

        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";

          for (const chunk of chunks) {
            if (!chunk.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(chunk.slice(6));
              if (data.type !== "history" && data.type !== "update") continue;
              const entries = data.entries as TraceEvent[];
              if (data.type === "history") {
                setEvents(entries);
              } else {
                setEvents((prev) => {
                  const ids = new Set(prev.map((p) => p.id));
                  const fresh = entries.filter((e) => !ids.has(e.id));
                  if (fresh.length === 0) return prev;
                  return [...prev, ...fresh].slice(-MAX_EVENTS);
                });
              }
            } catch {
              // skip malformed SSE
            }
          }
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setConnected(false);
      });

    return () => {
      cancelled = true;
      reader?.cancel();
    };
  }, [teamId, agentId]);

  const threads = useMemo(() => buildTickThreads(events), [events]);

  // Auto-scroll when new steps arrive (but not on the initial render).
  const stepCount = events.length;
  useEffect(() => {
    if (stepCount > prevCountRef.current && prevCountRef.current > 0) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevCountRef.current = stepCount;
  }, [stepCount]);

  if (threads.length === 0) {
    return (
      <div className="flex items-center justify-center h-full min-h-[120px]">
        <div className="text-center px-4 py-6">
          <p className="text-xs text-fg-faint font-mono">
            {connected ? "No trace yet" : "Connecting…"}
          </p>
          <p className="text-[11px] text-fg-faint mt-1">
            Every step appears here live on the next tick.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full overflow-y-auto ${compact ? "px-3 py-2" : "px-6 py-5"}`}>
      <div className={compact ? "space-y-3" : "max-w-3xl space-y-4"}>
        {threads.map((thread) => (
          <TickThreadBlock
            key={thread.tickId}
            agentName={agentNames?.[thread.agentId]}
            showAgent={!agentId}
            compact={compact}
            thread={thread}
          />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function TickThreadBlock({
  thread,
  agentName,
  showAgent,
  compact,
}: {
  thread: ReturnType<typeof buildTickThreads>[number];
  agentName?: string;
  showAgent: boolean;
  compact: boolean;
}) {
  const badge = STATUS_BADGE[thread.status];
  return (
    <div className="border border-border rounded-[10px] bg-bg-elev overflow-hidden">
      {/* Thread header */}
      <div
        className={`flex items-center gap-2 border-b border-border/60 bg-bg ${compact ? "px-3 py-1.5" : "px-4 py-2"}`}
      >
        <span className="text-[10px] text-fg-faint font-mono shrink-0">
          {formatTime(thread.startedAt)}
        </span>
        {showAgent && (
          <span className="text-[11px] font-medium text-fg truncate">
            {agentName ?? "agent"}
          </span>
        )}
        <span
          className={`ml-auto text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded shrink-0 ${badge.cls} ${thread.status === "live" ? "animate-pulse" : ""}`}
        >
          {badge.label}
        </span>
      </div>

      {/* Steps */}
      <div className={compact ? "px-3 py-1.5" : "px-4 py-2"}>
        {thread.steps.map((step) => (
          <StepRow key={step.id} step={step} compact={compact} />
        ))}
      </div>
    </div>
  );
}

const STEP_TONE: Record<TraceStepRow["kind"], string> = {
  tick_started: "text-fg-faint",
  llm: "text-fg-muted",
  tool: "text-fg",
  approval_requested: "text-brand",
  decision_applied: "text-fg-muted",
  tick_finished: "text-fg-faint",
  tick_failed: "text-error",
  unknown: "text-fg-faint",
};

function StepRow({ step, compact }: { step: TraceStepRow; compact: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const duration = fmtDuration(step.durationMs);
  const expandable = Boolean(step.detail);

  return (
    <div className={`${compact ? "py-[3px]" : "py-1"}`}>
      <div
        className={`flex items-baseline gap-2 font-mono text-[12px] ${expandable ? "cursor-pointer group" : ""}`}
        onClick={expandable ? () => setExpanded((v) => !v) : undefined}
        onKeyDown={
          expandable
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") setExpanded((v) => !v);
              }
            : undefined
        }
        role={expandable ? "button" : undefined}
        tabIndex={expandable ? 0 : undefined}
      >
        <span
          className={`shrink-0 w-3 text-center ${step.live ? "text-running animate-pulse" : "text-fg-faint"}`}
        >
          {step.glyph}
        </span>
        {!compact && (
          <span className="text-[10px] text-fg-faint shrink-0 w-[58px]">
            {formatTime(step.timestamp)}
          </span>
        )}
        <span
          className={`min-w-0 break-words leading-relaxed ${STEP_TONE[step.kind]} ${step.live ? "animate-pulse" : ""} ${expandable ? "group-hover:text-fg" : ""}`}
        >
          {step.label}
        </span>
        {duration && (
          <span className="text-[10px] text-fg-faint shrink-0 ml-auto">{duration}</span>
        )}
        {expandable && (
          <span className="text-[10px] text-fg-faint shrink-0 group-hover:text-fg-muted">
            {expanded ? "−" : "+"}
          </span>
        )}
      </div>
      {expanded && step.detail && (
        <pre className="mt-1 ml-5 text-[10px] text-fg-faint font-mono bg-bg rounded px-2.5 py-1.5 overflow-x-auto border border-border/30 max-h-[280px] whitespace-pre-wrap break-words">
          {step.detail}
        </pre>
      )}
    </div>
  );
}
