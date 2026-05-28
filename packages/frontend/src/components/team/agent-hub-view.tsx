"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentInfo {
  id: string;
  name: string;
  role: string;
  status: "running" | "paused" | "errored";
}

interface ActionEntry {
  type: "action";
  id: string;
  actionType: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

interface ReceivedEntry {
  type: "received";
  id: string;
  fromName: string;
  content: string;
  kind: string;
  channelType: string;
  timestamp: string;
}

type TimelineEntry = ActionEntry | ReceivedEntry;

interface HubData {
  agentId: string;
  agentName: string;
  agentRole: string;
  agentStatus: string;
  agentSchedule: number;
  nextRunAt: string | null;
  inFlight: boolean;
  timeline: TimelineEntry[];
}

interface AgentHubViewProps {
  teamId: string;
  agents: AgentInfo[];
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatSchedule(seconds: number): string {
  if (seconds < 60) return `every ${seconds}s`;
  if (seconds < 3600) return `every ${Math.round(seconds / 60)}m`;
  return `every ${Math.round(seconds / 3600)}h`;
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

function describeSubAction(action: Record<string, unknown>): { glyph: string; text: string } {
  const t = action.type as string;
  switch (t) {
    case "message_sent":
      return { glyph: "→", text: `${action.to || "agent"}: "${truncate(action.content as string, 100)}"` };
    case "broadcast_sent":
      return { glyph: "→→", text: `broadcast: "${truncate(action.content as string, 100)}"` };
    case "agent_thought":
      return { glyph: "·", text: truncate(action.content as string, 120) };
    case "feedback_scan":
      return { glyph: "○", text: `scanned ${action.source || "feedback channels"}` };
    default: {
      const summary = action.summary as string | undefined;
      return { glyph: "•", text: summary ?? t.replace(/_/g, " ") };
    }
  }
}

function describeAction(actionType: string, payload: Record<string, unknown>): string {
  switch (actionType) {
    case "message_sent":
      return `messaged ${payload.to || "an agent"}: "${truncate(payload.content as string, 120)}"`;
    case "broadcast_sent":
      return `broadcast to ${payload.peerCount || 0} peers: "${truncate(payload.content as string, 100)}"`;
    case "multi_action": {
      const actions = (payload.actions as Array<Record<string, unknown>> | undefined) ?? [];
      return `${actions.length} action${actions.length === 1 ? "" : "s"} this tick`;
    }
    case "agent_thought":
      return truncate((payload.content as string) || "thinking", 140);
    case "noop":
      return "no action needed this tick";
    default: {
      const summary = payload.summary as string | undefined;
      if (summary) return summary;
      return actionType.replace(/_/g, " ");
    }
  }
}

const STATUS_STYLE: Record<string, { dot: string; text: string; label: string }> = {
  running: { dot: "bg-running", text: "text-running", label: "running" },
  paused: { dot: "bg-paused", text: "text-paused", label: "paused" },
  errored: { dot: "bg-error", text: "text-error", label: "errored" },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentHubView({ teamId, agents, onClose }: AgentHubViewProps) {
  const [selectedId, setSelectedId] = useState<string>(agents[0]?.id ?? "");
  const [data, setData] = useState<HubData | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);

  const fetchHub = useCallback(
    async (agentId: string) => {
      if (!agentId) return;
      setLoading(true);
      try {
        const res = await fetch(`/api/team/${teamId}/agent-hub?agentId=${agentId}`);
        if (res.ok) {
          setData(await res.json());
        }
      } catch {
        // silent
      } finally {
        setLoading(false);
      }
    },
    [teamId],
  );

  useEffect(() => {
    fetchHub(selectedId);
    const interval = setInterval(() => fetchHub(selectedId), 5000);
    return () => clearInterval(interval);
  }, [selectedId, fetchHub]);

  // Scroll to bottom only when new entries arrive (not on first load).
  useEffect(() => {
    const count = data?.timeline.length ?? 0;
    if (count > prevCountRef.current && prevCountRef.current > 0) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevCountRef.current = count;
  }, [data?.timeline.length]);

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSwitch = (agentId: string) => {
    setSelectedId(agentId);
    setData(null);
    setExpanded(new Set());
    prevCountRef.current = 0;
  };

  const style = STATUS_STYLE[data?.agentStatus ?? "running"] ?? STATUS_STYLE.running;

  return (
    <div className="flex h-full min-h-0">
      {/* Agent list sidebar */}
      <div className="w-[220px] border-r border-border bg-bg flex flex-col min-h-0 shrink-0">
        <div className="px-4 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <button type="button" onClick={onClose} className="text-fg-faint hover:text-fg cursor-pointer">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5" />
                <path d="M12 19l-7-7 7-7" />
              </svg>
            </button>
            <span className="text-[11px] text-fg-faint font-mono uppercase tracking-wider">
              Agent Hub
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {agents.map((a) => {
            const isActive = a.id === selectedId;
            const s = STATUS_STYLE[a.status] ?? STATUS_STYLE.running;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => handleSwitch(a.id)}
                className={`w-full text-left px-4 py-3 border-b border-border cursor-pointer transition-colors ${
                  isActive ? "bg-bg-elev" : "hover:bg-bg-elev/50"
                }`}
              >
                <div className="flex items-center gap-2 mb-0.5">
                  <span className={`w-2 h-2 rounded-full shrink-0 ${s.dot}`} />
                  <span className={`text-sm font-medium truncate ${isActive ? "text-fg" : "text-fg-muted"}`}>
                    {a.name}
                  </span>
                </div>
                <div className="text-[11px] text-fg-faint font-mono truncate pl-4">
                  {a.role}
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Main timeline area */}
      <div className="flex-1 flex flex-col min-h-0 bg-bg">
        {/* Agent info bar */}
        {data && (
          <div className="px-5 py-3 border-b border-border flex items-center gap-4 shrink-0 bg-bg-elev">
            <div className="flex items-center gap-2">
              <span
                className={`w-2.5 h-2.5 rounded-full ${style.dot} ${data.inFlight ? "animate-pulse" : ""}`}
              />
              <span className="text-[15px] font-semibold text-fg">{data.agentName}</span>
            </div>
            <span className="text-[12px] text-fg-muted font-mono">{data.agentRole}</span>
            <div className="ml-auto flex items-center gap-3">
              <span className="text-[11px] text-fg-faint font-mono">
                {formatSchedule(data.agentSchedule)}
              </span>
              <span className={`text-[11px] font-mono font-medium ${style.text}`}>
                {data.inFlight ? "thinking..." : style.label}
              </span>
            </div>
          </div>
        )}

        {/* Timeline */}
        <div className="flex-1 overflow-y-auto">
          {loading && !data && (
            <div className="flex items-center justify-center h-full">
              <span className="text-xs text-fg-faint font-mono">loading timeline...</span>
            </div>
          )}

          {data && data.timeline.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="text-fg-faint mb-2">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto">
                    <circle cx="12" cy="12" r="10" />
                    <polyline points="12 6 12 12 16 14" />
                  </svg>
                </div>
                <p className="text-xs text-fg-faint font-mono">No activity yet</p>
                <p className="text-[11px] text-fg-faint mt-1">
                  Actions will appear here after the first tick.
                </p>
              </div>
            </div>
          )}

          {data && data.timeline.length > 0 && (
            <div className="px-6 py-5">
              <div className="relative">
                {/* Vertical timeline spine */}
                <div className="absolute left-[7px] top-3 bottom-3 w-px bg-border" />

                {data.timeline.map((entry) => {
                  if (entry.type === "action") {
                    return (
                      <ActionNode
                        key={entry.id}
                        entry={entry}
                        isExpanded={expanded.has(entry.id)}
                        onToggle={() => toggleExpand(entry.id)}
                      />
                    );
                  }
                  return <ReceivedNode key={entry.id} entry={entry} />;
                })}

                <div ref={endRef} />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline nodes
// ---------------------------------------------------------------------------

function ActionNode({
  entry,
  isExpanded,
  onToggle,
}: {
  entry: ActionEntry;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const isMulti = entry.actionType === "multi_action";
  const subActions =
    isMulti
      ? ((entry.payload.actions as Array<Record<string, unknown>> | undefined) ?? [])
      : [];
  const isNoop = entry.actionType === "noop";

  return (
    <div className="relative pl-8 pb-4">
      {/* Dot on the spine */}
      <div
        className={`absolute left-0 top-[7px] w-[15px] h-[15px] rounded-full border-2 border-bg ${
          isNoop ? "bg-border" : "bg-brand"
        }`}
      />

      <div
        className={`border rounded-lg px-4 py-3 transition-colors ${
          isNoop
            ? "border-border/50 bg-bg"
            : "border-border bg-bg-elev hover:border-brand/30"
        }`}
      >
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] text-fg-faint font-mono shrink-0">
              {formatTime(entry.timestamp)}
            </span>
            <span className="text-[10px] text-fg-faint font-mono px-1.5 py-0.5 rounded bg-bg shrink-0">
              {entry.actionType.replace(/_/g, " ")}
            </span>
          </div>
          {isMulti && subActions.length > 0 && (
            <button
              type="button"
              onClick={onToggle}
              className="text-[10px] text-brand font-mono hover:text-brand/80 cursor-pointer shrink-0"
            >
              {isExpanded ? "collapse" : `${subActions.length} details`}
            </button>
          )}
        </div>

        <div className={`text-[13px] leading-relaxed mt-1.5 ${isNoop ? "text-fg-faint" : "text-fg-muted"}`}>
          {describeAction(entry.actionType, entry.payload)}
        </div>

        {/* Expanded sub-actions for multi_action */}
        {isMulti && isExpanded && subActions.length > 0 && (
          <div className="mt-3 border-t border-border pt-3 space-y-2">
            {subActions.map((sub, j) => {
              const { glyph, text } = describeSubAction(sub);
              return (
                <div
                  key={j}
                  className="text-[12px] text-fg-muted font-mono pl-3 border-l-2 border-brand/30 leading-relaxed"
                >
                  <span className="text-fg-faint mr-1.5">{glyph}</span>
                  {text}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function ReceivedNode({ entry }: { entry: ReceivedEntry }) {
  return (
    <div className="relative pl-8 pb-4">
      {/* Smaller dot on the spine */}
      <div className="absolute left-[3px] top-[10px] w-[9px] h-[9px] rounded-full bg-fg-faint/30" />

      <div className="border border-border/40 rounded-lg px-4 py-2.5 bg-bg">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] text-fg-faint font-mono">
            {formatTime(entry.timestamp)}
          </span>
          <span className="text-[10px] text-fg-faint">&larr;</span>
          <span className="text-[12px] text-fg-muted font-medium">{entry.fromName}</span>
          <span className="text-[10px] text-fg-faint font-mono ml-auto">{entry.channelType}</span>
        </div>
        <div className="text-[12px] text-fg-faint leading-relaxed">
          {truncate(entry.content, 200)}
        </div>
      </div>
    </div>
  );
}
