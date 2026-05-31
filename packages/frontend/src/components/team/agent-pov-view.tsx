"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { USER_AGENT_ID } from "@simple-harmonic/backend/lib/meta-agent/identity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AgentDetail {
  id: string;
  name: string;
  role: string;
  archetype: string;
  tools: string[];
  scheduleSeconds: number;
  initialPrompt: string;
  status: "running" | "paused" | "errored" | "awaiting_approval";
  inFlight: boolean;
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

interface A2AXMessage {
  id: string;
  channelType: "direct" | "broadcast" | "group" | "task";
  channelId: string;
  fromAgentId: string;
  fromAgentName: string;
  kind: string;
  content: string;
  status: string;
  urgent: boolean;
  createdAt: string;
}

interface AgentPovViewProps {
  teamId: string;
  agent: AgentDetail;
  teamAgents: { id: string; name: string }[];
  onUpdated: (agent: AgentDetail) => void;
}

type ActiveTab = "dashboard" | "history" | "messages" | "config";
type ViewMode = "normal" | "thinking" | "verbose";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ARCHETYPES = [
  "support-responder",
  "content-scheduler",
  "sales-followup",
  "ops-monitor",
  "research-summarizer",
];

const STATUS_STYLE: Record<string, { dot: string; text: string; label: string }> = {
  running: { dot: "bg-running", text: "text-running", label: "running" },
  paused: { dot: "bg-paused", text: "text-paused", label: "paused" },
  errored: { dot: "bg-error", text: "text-error", label: "errored" },
  awaiting_approval: { dot: "bg-brand", text: "text-brand", label: "awaiting approval" },
};

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

function formatScheduleShort(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
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

function channelBadge(type: string) {
  const colors: Record<string, string> = {
    direct: "bg-blue-500/15 text-blue-400",
    broadcast: "bg-amber-500/15 text-amber-400",
    group: "bg-emerald-500/15 text-emerald-400",
    task: "bg-purple-500/15 text-purple-400",
  };
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${colors[type] ?? "bg-border text-fg-faint"}`}>
      {type}
    </span>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[9px] text-fg-faint font-mono uppercase tracking-[1.5px] mb-1.5">
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function AgentPovView({ teamId, agent, teamAgents, onUpdated }: AgentPovViewProps) {
  const [tab, setTab] = useState<ActiveTab>("dashboard");
  const [viewMode, setViewMode] = useState<ViewMode>("normal");

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Agent header */}
      <AgentHeader agent={agent} />

      {/* Tabs + view mode */}
      <div className="flex items-center border-b border-border shrink-0 bg-bg-elev px-5">
        <div className="flex">
          {(["dashboard", "history", "messages", "config"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-[10px] font-mono uppercase tracking-wider cursor-pointer transition-colors ${
                tab === t
                  ? "text-fg border-b-2 border-brand"
                  : "text-fg-faint hover:text-fg-muted"
              }`}
            >
              {t}
            </button>
          ))}
        </div>

        {/* View mode toggle, only visible on history tab */}
        {tab === "history" && (
          <div className="ml-auto flex items-center gap-0.5 bg-bg rounded-md border border-border p-0.5">
            {(["normal", "thinking", "verbose"] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setViewMode(m)}
                className={`px-2.5 py-1 text-[10px] font-mono rounded cursor-pointer transition-colors ${
                  viewMode === m
                    ? "bg-bg-elev text-fg"
                    : "text-fg-faint hover:text-fg-muted"
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0">
        {tab === "dashboard" && (
          <DashboardTab teamId={teamId} agent={agent} />
        )}
        {tab === "history" && (
          <HistoryTab teamId={teamId} agentId={agent.id} viewMode={viewMode} />
        )}
        {tab === "messages" && (
          <MessagesTab teamId={teamId} agent={agent} teamAgents={teamAgents} />
        )}
        {tab === "config" && (
          <ConfigTab agent={agent} onUpdated={onUpdated} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Agent Header
// ---------------------------------------------------------------------------

function AgentHeader({ agent }: { agent: AgentDetail }) {
  const style = STATUS_STYLE[agent.status] ?? STATUS_STYLE.running;
  return (
    <div className="px-5 py-3.5 border-b border-border flex items-center gap-4 shrink-0 bg-bg">
      <div className="flex items-center gap-2.5">
        <span
          className={`w-2.5 h-2.5 rounded-full ${style.dot} ${agent.inFlight ? "animate-pulse" : ""}`}
        />
        <span className="text-[16px] font-semibold text-fg">{agent.name}</span>
      </div>
      <span className="text-[12px] text-fg-muted font-mono leading-snug line-clamp-1">
        {agent.role}
      </span>
      <div className="ml-auto flex items-center gap-3">
        <span className="text-[11px] text-fg-faint font-mono">
          {formatSchedule(agent.scheduleSeconds)}
        </span>
        <span className={`text-[11px] font-mono font-medium ${style.text}`}>
          {agent.inFlight ? "thinking..." : style.label}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard Tab
// ---------------------------------------------------------------------------

function DashboardTab({ teamId, agent }: { teamId: string; agent: AgentDetail }) {
  const [data, setData] = useState<HubData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchHub = async () => {
      try {
        const res = await fetch(`/api/team/${teamId}/agent-hub?agentId=${agent.id}`);
        if (res.ok && !cancelled) setData(await res.json());
      } catch { /* silent */ }
    };
    fetchHub();
    const interval = setInterval(fetchHub, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [teamId, agent.id]);

  const actions = data?.timeline.filter((e) => e.type === "action") ?? [];
  const received = data?.timeline.filter((e) => e.type === "received") ?? [];
  const msgsSent = actions.filter(
    (e) => e.type === "action" && (e.actionType === "message_sent" || e.actionType === "broadcast_sent"),
  ).length;
  const multiActions = actions.filter((e) => e.type === "action" && e.actionType === "multi_action");
  const subMsgCount = multiActions.reduce((sum, e) => {
    if (e.type !== "action") return sum;
    const subs = (e.payload.actions as Array<Record<string, unknown>> | undefined) ?? [];
    return sum + subs.filter((s) => s.type === "message_sent" || s.type === "broadcast_sent").length;
  }, 0);
  const totalMsgsSent = msgsSent + subMsgCount;
  const noops = actions.filter((e) => e.type === "action" && e.actionType === "noop").length;
  const totalActions = actions.length;
  const activeRate = totalActions > 0 ? Math.round(((totalActions - noops) / totalActions) * 100) : 0;
  const tokensUp = totalActions * 400;
  const tokensDown = totalActions * 1200;
  const cost = (tokensUp * 3 + tokensDown * 15) / 1_000_000;

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="space-y-6">
        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-3">
          <StatCard label="Total Actions" value={String(totalActions)} sub={`${activeRate}% active`} />
          <StatCard label="Messages Sent" value={String(totalMsgsSent)} />
          <StatCard label="Messages Received" value={String(received.length)} />
          <StatCard label="Tokens In" value={fmtNum(tokensUp)} />
          <StatCard label="Tokens Out" value={fmtNum(tokensDown)} />
          <StatCard label="Est. Cost" value={`$${cost.toFixed(2)}`} />
        </div>

        {/* Tools */}
        {agent.tools.length > 0 && (
          <div>
            <div className="text-[9px] text-fg-faint font-mono uppercase tracking-[1.5px] mb-2">Tools</div>
            <div className="flex flex-wrap gap-1.5">
              {agent.tools.map((t) => (
                <span key={t} className="text-[11px] font-mono bg-bg border border-border rounded px-2 py-0.5 text-fg-muted">{t}</span>
              ))}
            </div>
          </div>
        )}

        {/* Recent activity */}
        {data && data.timeline.length > 0 && (
          <div>
            <div className="text-[9px] text-fg-faint font-mono uppercase tracking-[1.5px] mb-2">Recent Activity</div>
            <div className="space-y-1.5">
              {data.timeline.slice(-5).reverse().map((entry) => (
                <div key={entry.type === "action" ? entry.id : entry.id} className="flex items-baseline gap-2 text-[12px] font-mono">
                  <span className="text-fg-faint shrink-0">{formatTime(entry.timestamp)}</span>
                  <span className="text-fg-muted truncate">
                    {entry.type === "action"
                      ? describeActionNormal(entry.actionType, entry.payload)
                      : `← ${entry.fromName}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-border rounded px-4 py-3 bg-bg">
      <div className="text-[9px] text-fg-faint font-mono uppercase tracking-[1.5px]">{label}</div>
      <div className="text-[18px] font-semibold tracking-tight text-fg mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-fg-faint font-mono mt-0.5">{sub}</div>}
    </div>
  );
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ---------------------------------------------------------------------------
// History Tab
// ---------------------------------------------------------------------------

// Normal: succinct, outcomes only. No thinking, no received messages.
// Thinking: includes agent_thought + received messages, expandable sub-actions.
// Verbose: everything from thinking + auto-expanded + raw payload JSON.

function describeActionNormal(actionType: string, payload: Record<string, unknown>): string {
  switch (actionType) {
    case "message_sent":
      return `→ ${payload.to || "agent"}`;
    case "broadcast_sent":
      return `→→ ${payload.peerCount || 0} peers`;
    case "multi_action": {
      const actions = (payload.actions as Array<Record<string, unknown>> | undefined) ?? [];
      const types = actions.map((a) => a.type as string);
      const msgs = types.filter((t) => t === "message_sent" || t === "broadcast_sent").length;
      const other = types.length - msgs;
      const parts: string[] = [];
      if (msgs > 0) parts.push(`${msgs} msg${msgs > 1 ? "s" : ""}`);
      if (other > 0) parts.push(`${other} other`);
      return parts.join(", ") || `${actions.length} actions`;
    }
    case "noop":
      return "idle";
    case "agent_thought":
      return truncate((payload.content as string) || "thinking", 60);
    default: {
      const summary = payload.summary as string | undefined;
      if (summary) return truncate(summary, 60);
      return actionType.replace(/_/g, " ");
    }
  }
}

function filterTimeline(timeline: TimelineEntry[], mode: ViewMode): TimelineEntry[] {
  if (mode === "normal") {
    // Hide thinking and received messages
    return timeline.filter((e) => {
      if (e.type === "received") return false;
      if (e.type === "action" && e.actionType === "agent_thought") return false;
      return true;
    });
  }
  // thinking + verbose: show everything
  return timeline;
}

function HistoryTab({
  teamId,
  agentId,
  viewMode,
}: {
  teamId: string;
  agentId: string;
  viewMode: ViewMode;
}) {
  const [data, setData] = useState<HubData | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const endRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);

  const fetchHub = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/team/${teamId}/agent-hub?agentId=${agentId}`);
      if (res.ok) setData(await res.json());
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [teamId, agentId]);

  useEffect(() => {
    fetchHub();
    const interval = setInterval(fetchHub, 5000);
    return () => clearInterval(interval);
  }, [fetchHub]);

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

  if (loading && !data) {
    return (
      <div className="flex items-center justify-center h-full">
        <span className="text-xs text-fg-faint font-mono">loading...</span>
      </div>
    );
  }

  if (data && data.timeline.length === 0) {
    return (
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
    );
  }

  const filtered = filterTimeline(data?.timeline ?? [], viewMode);

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="relative max-w-3xl">
        <div className="absolute left-[7px] top-3 bottom-3 w-px bg-border" />
        {filtered.map((entry) => {
          if (entry.type === "action") {
            return (
              <ActionNode
                key={entry.id}
                entry={entry}
                viewMode={viewMode}
                isExpanded={viewMode === "verbose" || expanded.has(entry.id)}
                onToggle={() => toggleExpand(entry.id)}
              />
            );
          }
          return <ReceivedNode key={entry.id} entry={entry} viewMode={viewMode} />;
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Timeline Nodes
// ---------------------------------------------------------------------------

function ActionNode({
  entry,
  viewMode,
  isExpanded,
  onToggle,
}: {
  entry: ActionEntry;
  viewMode: ViewMode;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const isMulti = entry.actionType === "multi_action";
  const subActions = isMulti
    ? ((entry.payload.actions as Array<Record<string, unknown>> | undefined) ?? [])
    : [];
  const isNoop = entry.actionType === "noop";
  const isThought = entry.actionType === "agent_thought";

  // Normal mode: compact single-line rendering
  if (viewMode === "normal") {
    return (
      <div className="relative pl-8 pb-2.5">
        <div
          className={`absolute left-[2px] top-[6px] w-[11px] h-[11px] rounded-full ${
            isNoop ? "bg-border" : "bg-brand"
          }`}
        />
        <div className="flex items-baseline gap-2 py-1">
          <span className="text-[10px] text-fg-faint font-mono shrink-0">
            {formatTime(entry.timestamp)}
          </span>
          <span className={`text-[13px] font-mono ${isNoop ? "text-fg-faint" : "text-fg-muted"}`}>
            {describeActionNormal(entry.actionType, entry.payload)}
          </span>
        </div>
      </div>
    );
  }

  // Thinking + Verbose modes: card-based rendering
  return (
    <div className="relative pl-8 pb-4">
      <div
        className={`absolute left-0 top-[7px] w-[15px] h-[15px] rounded-full border-2 border-bg ${
          isNoop ? "bg-border" : isThought ? "bg-fg-faint/40" : "bg-brand"
        }`}
      />
      <div
        className={`border rounded px-4 py-3 transition-colors ${
          isNoop
            ? "border-border/50 bg-bg"
            : isThought
              ? "border-border/30 bg-bg border-dashed"
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
          {isMulti && subActions.length > 0 && viewMode !== "verbose" && (
            <button
              type="button"
              onClick={onToggle}
              className="text-[10px] text-brand font-mono hover:text-brand/80 cursor-pointer shrink-0"
            >
              {isExpanded ? "collapse" : `${subActions.length} details`}
            </button>
          )}
        </div>

        <div className={`text-[13px] leading-relaxed mt-1.5 ${isNoop || isThought ? "text-fg-faint" : "text-fg-muted"}`}>
          {describeAction(entry.actionType, entry.payload)}
        </div>

        {/* Sub-actions (thinking: expandable, verbose: always shown) */}
        {isMulti && isExpanded && subActions.length > 0 && (
          <div className="mt-3 border-t border-border pt-3 space-y-2">
            {subActions.map((sub, j) => {
              const { glyph, text } = describeSubAction(sub);
              return (
                <div key={j}>
                  <div className="text-[12px] text-fg-muted font-mono pl-3 border-l-2 border-brand/30 leading-relaxed">
                    <span className="text-fg-faint mr-1.5">{glyph}</span>
                    {viewMode === "verbose" ? (sub.content as string || text) : text}
                  </div>
                  {/* Verbose: show raw sub-action params */}
                  {viewMode === "verbose" && (
                    <pre className="ml-3 mt-1 text-[10px] text-fg-faint font-mono bg-bg rounded px-2.5 py-1.5 overflow-x-auto border border-border/30">
                      {JSON.stringify(sub, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Verbose: raw payload for non-multi actions */}
        {viewMode === "verbose" && !isMulti && (
          <pre className="mt-3 text-[10px] text-fg-faint font-mono bg-bg rounded px-3 py-2 overflow-x-auto border border-border/30 max-h-[300px]">
            {JSON.stringify(entry.payload, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

function ReceivedNode({ entry, viewMode }: { entry: ReceivedEntry; viewMode: ViewMode }) {
  // Normal mode filters these out at the timeline level, but guard here too
  if (viewMode === "normal") return null;

  return (
    <div className="relative pl-8 pb-4">
      <div className="absolute left-[3px] top-[10px] w-[9px] h-[9px] rounded-full bg-fg-faint/30" />
      <div className="border border-border/40 rounded px-4 py-2.5 bg-bg">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] text-fg-faint font-mono">
            {formatTime(entry.timestamp)}
          </span>
          <span className="text-[10px] text-fg-faint">&larr;</span>
          <span className="text-[12px] text-fg-muted font-medium">{entry.fromName}</span>
          <span className="text-[10px] text-fg-faint font-mono ml-auto">{entry.channelType}</span>
        </div>
        <div className="text-[12px] text-fg-faint leading-relaxed">
          {viewMode === "verbose" ? entry.content : truncate(entry.content, 200)}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Messages Tab
// ---------------------------------------------------------------------------

function MessagesTab({
  teamId,
  agent,
  teamAgents,
}: {
  teamId: string;
  agent: AgentDetail;
  teamAgents: { id: string; name: string }[];
}) {
  const [messages, setMessages] = useState<A2AXMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const fetchMessages = useCallback(() => {
    setLoading(true);
    fetch(`/api/team/${teamId}/messages?agentId=${agent.id}`)
      .then((r) => r.json())
      .then((data) => setMessages(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [teamId, agent.id]);

  useEffect(() => {
    fetchMessages();
    const interval = setInterval(fetchMessages, 5000);
    return () => clearInterval(interval);
  }, [fetchMessages]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const handleSend = async () => {
    if (!content.trim()) return;
    setSending(true);
    try {
      await fetch(`/api/team/${teamId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAgentId: USER_AGENT_ID,
          toAgentId: agent.id,
          content: content.trim(),
          channelType: "direct",
        }),
      });
      setContent("");
      fetchMessages();
    } finally {
      setSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const isFromAgent = (m: A2AXMessage) => m.fromAgentId === agent.id;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-5 py-4">
        {loading && messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <span className="text-xs text-fg-faint font-mono">loading messages...</span>
          </div>
        ) : messages.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <p className="text-xs text-fg-faint font-mono">No messages yet</p>
              <p className="text-[11px] text-fg-faint mt-1">
                Send a message below, or wait for the agent to communicate.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`border rounded px-4 py-3 ${
                  m.urgent ? "border-brand/40 bg-brand/5" : "border-border"
                } ${isFromAgent(m) ? "bg-bg-elev" : "bg-bg"}`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    {channelBadge(m.channelType)}
                    <span className="text-[12px] font-mono text-fg-muted">
                      {isFromAgent(m) ? (
                        <><span className="text-fg font-medium">{agent.name}</span> sent</>
                      ) : (
                        <>from <span className="text-fg font-medium">{m.fromAgentName}</span></>
                      )}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-fg-faint">
                    {timeAgo(m.createdAt)}
                    {m.urgent && <span className="ml-1.5 text-brand">urgent</span>}
                  </span>
                </div>
                <p className="text-[13px] text-fg leading-relaxed">{m.content}</p>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>

      {/* Compose */}
      <div className="px-5 py-3 border-t border-border shrink-0 bg-bg-elev">
        <div className="flex items-end gap-2">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Message ${agent.name} as You...`}
            rows={1}
            className="flex-1 bg-bg border border-border rounded px-4 py-2.5 text-sm text-fg placeholder:text-fg-faint font-mono resize-none focus:outline-none focus:border-brand transition-colors"
            style={{ minHeight: "40px", maxHeight: "120px" }}
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = "auto";
              target.style.height = `${Math.min(target.scrollHeight, 120)}px`;
            }}
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={!content.trim() || sending}
            className="bg-brand text-white p-2.5 rounded disabled:opacity-30 cursor-pointer transition-opacity shrink-0"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13" />
              <polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Config Tab
// ---------------------------------------------------------------------------

function ConfigTab({
  agent,
  onUpdated,
}: {
  agent: AgentDetail;
  onUpdated: (agent: AgentDetail) => void;
}) {
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [archetype, setArchetype] = useState(agent.archetype);
  const [toolsText, setToolsText] = useState(agent.tools.join(", "));
  const [scheduleSeconds, setScheduleSeconds] = useState(agent.scheduleSeconds);
  const [initialPrompt, setInitialPrompt] = useState(agent.initialPrompt);
  const [status, setStatus] = useState(agent.status);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Sync when parent agent changes (e.g. after save propagates)
  useEffect(() => {
    setName(agent.name);
    setRole(agent.role);
    setArchetype(agent.archetype);
    setToolsText(agent.tools.join(", "));
    setScheduleSeconds(agent.scheduleSeconds);
    setInitialPrompt(agent.initialPrompt);
    setStatus(agent.status);
    setDirty(false);
  }, [agent]);

  const markDirty = useCallback(<T,>(setter: (v: T) => void) => {
    return (v: T) => {
      setter(v);
      setDirty(true);
    };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const tools = toolsText.split(",").map((t) => t.trim()).filter(Boolean);
      const body: Record<string, unknown> = {
        name,
        role,
        archetype,
        tools,
        scheduleSeconds,
        initialPrompt,
      };
      if (status !== "awaiting_approval") {
        body.status = status;
      }
      const res = await fetch(`/api/agent/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const updated = await res.json();
        onUpdated(updated);
        setDirty(false);
      }
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full bg-bg border border-border rounded px-3 py-2 text-sm text-fg focus:outline-none focus:border-brand transition-colors";

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto px-5 py-5">
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-2 gap-5">
            <div>
              <FieldLabel>Name</FieldLabel>
              <input
                className={inputClass}
                value={name}
                onChange={(e) => markDirty(setName)(e.target.value)}
              />
            </div>
            <div>
              <FieldLabel>Archetype</FieldLabel>
              <select
                className={inputClass}
                value={archetype}
                onChange={(e) => markDirty(setArchetype)(e.target.value)}
              >
                {ARCHETYPES.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <FieldLabel>Role</FieldLabel>
            <input
              className={inputClass}
              value={role}
              onChange={(e) => markDirty(setRole)(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-5">
            <div>
              <FieldLabel>Status</FieldLabel>
              <select
                className={inputClass}
                value={status}
                disabled={agent.status === "awaiting_approval"}
                onChange={(e) => markDirty(setStatus)(e.target.value as AgentDetail["status"])}
              >
                <option value="running">running</option>
                <option value="paused">paused</option>
                <option value="errored">errored</option>
                <option value="awaiting_approval">awaiting approval</option>
              </select>
            </div>
            <div>
              <FieldLabel>Schedule</FieldLabel>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={10}
                  max={3600}
                  step={10}
                  value={scheduleSeconds}
                  onChange={(e) => markDirty(setScheduleSeconds)(Number(e.target.value))}
                  className="flex-1 accent-brand"
                />
                <span className="text-xs font-mono text-fg-muted w-12 text-right">
                  {formatScheduleShort(scheduleSeconds)}
                </span>
              </div>
            </div>
          </div>

          <div>
            <FieldLabel>Tools</FieldLabel>
            <input
              className={inputClass}
              value={toolsText}
              onChange={(e) => markDirty(setToolsText)(e.target.value)}
              placeholder="comma-separated tool names"
            />
            {toolsText && (
              <div className="flex flex-wrap gap-1.5 mt-2">
                {toolsText
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean)
                  .map((t) => (
                    <span
                      key={t}
                      className="text-[11px] font-mono bg-bg border border-border rounded px-2 py-0.5 text-fg-muted"
                    >
                      {t}
                    </span>
                  ))}
              </div>
            )}
          </div>

          <div>
            <FieldLabel>System Prompt</FieldLabel>
            <textarea
              className={`${inputClass} min-h-[200px] font-mono text-xs leading-relaxed resize-y`}
              value={initialPrompt}
              onChange={(e) => markDirty(setInitialPrompt)(e.target.value)}
            />
          </div>
        </div>
      </div>

      {/* Save bar */}
      {dirty && (
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-3 shrink-0 bg-bg-elev">
          <span className="text-[11px] text-fg-faint font-mono mr-auto">Unsaved changes</span>
          <button
            type="button"
            onClick={() => {
              setName(agent.name);
              setRole(agent.role);
              setArchetype(agent.archetype);
              setToolsText(agent.tools.join(", "));
              setScheduleSeconds(agent.scheduleSeconds);
              setInitialPrompt(agent.initialPrompt);
              setStatus(agent.status);
              setDirty(false);
            }}
            className="text-sm text-fg-muted hover:text-fg cursor-pointer px-3 py-1.5"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="bg-brand text-white text-sm font-medium px-4 py-1.5 rounded disabled:opacity-40 cursor-pointer"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}
