"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  COFOUNDER_AGENT_ID,
  USER_AGENT_ID,
} from "@simple-harmonic/backend/lib/meta-agent/identity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface TimelineEntry {
  type: "action" | "received" | "sent";
  id: string;
  actionType?: string;
  payload?: Record<string, unknown>;
  fromName?: string;
  toName?: string;
  content?: string;
  kind?: string;
  channelType?: string;
  timestamp: string;
}

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

interface TeamAgent {
  id: string;
  name: string;
}

interface UserPovViewProps {
  teamId: string;
  userName: string;
  teamAgents: TeamAgent[];
  cofounderName: string;
}

type ActiveTab = "messages" | "dashboard";

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

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
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

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function UserPovView({ teamId, userName, teamAgents, cofounderName }: UserPovViewProps) {
  const [tab, setTab] = useState<ActiveTab>("messages");

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* User header */}
      <div className="px-5 py-3.5 border-b border-border flex items-center gap-4 shrink-0 bg-bg">
        <div className="flex items-center gap-2.5">
          <span className="w-2.5 h-2.5 rounded-full bg-user" />
          <span className="text-[16px] font-semibold text-fg">{userName}</span>
        </div>
        <span className="text-[10px] text-fg-faint font-mono uppercase tracking-[1px] leading-snug">
          Founder
        </span>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-[10px] font-mono font-medium text-user uppercase tracking-[1px]">
            online
          </span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center border-b border-border shrink-0 bg-bg-elev px-5">
        <div className="flex">
          {(["messages", "dashboard"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-[10px] font-mono uppercase tracking-wider cursor-pointer transition-colors ${
                tab === t
                  ? "text-fg border-b-2 border-user"
                  : "text-fg-faint hover:text-fg-muted"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0">
        {tab === "messages" && (
          <UserMessagesTab
            teamId={teamId}
            userName={userName}
            teamAgents={teamAgents}
            cofounderName={cofounderName}
          />
        )}
        {tab === "dashboard" && (
          <UserDashboardTab teamId={teamId} userName={userName} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Messages Tab
// ---------------------------------------------------------------------------

function UserMessagesTab({
  teamId,
  userName,
  teamAgents,
  cofounderName,
}: {
  teamId: string;
  userName: string;
  teamAgents: TeamAgent[];
  cofounderName: string;
}) {
  const [messages, setMessages] = useState<A2AXMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [recipient, setRecipient] = useState<string>("broadcast");
  const endRef = useRef<HTMLDivElement>(null);

  // All possible recipients: cofounder + agents + broadcast
  const recipients = [
    { id: "broadcast", name: "All (broadcast)" },
    { id: COFOUNDER_AGENT_ID, name: cofounderName },
    ...teamAgents.map((a) => ({ id: a.id, name: a.name })),
  ];

  const fetchMessages = useCallback(() => {
    setLoading(true);
    fetch(`/api/team/${teamId}/messages?agentId=${USER_AGENT_ID}`)
      .then((r) => r.json())
      .then((data) => setMessages(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [teamId]);

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
      const body: Record<string, string> = {
        fromAgentId: USER_AGENT_ID,
        content: content.trim(),
        channelType: recipient === "broadcast" ? "broadcast" : "direct",
      };
      if (recipient !== "broadcast") {
        body.toAgentId = recipient;
      }
      await fetch(`/api/team/${teamId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
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

  const isFromUser = (m: A2AXMessage) => m.fromAgentId === USER_AGENT_ID;

  // Resolve name for display
  const nameMap: Record<string, string> = {
    [USER_AGENT_ID]: userName,
    [COFOUNDER_AGENT_ID]: cofounderName,
  };
  for (const a of teamAgents) {
    nameMap[a.id] = a.name;
  }

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
              <div className="text-fg-faint mb-2">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <p className="text-xs text-fg-faint font-mono">No messages yet</p>
              <p className="text-[11px] text-fg-faint mt-1">
                Send a message to your agents or broadcast to the whole team.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`border rounded px-4 py-3 ${
                  m.urgent ? "border-user/40 bg-user-soft/30" : "border-border"
                } ${isFromUser(m) ? "bg-user-soft/20 border-user/20" : "bg-bg-elev"}`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    {channelBadge(m.channelType)}
                    <span className="text-[12px] font-mono text-fg-muted">
                      {isFromUser(m) ? (
                        <><span className="text-user font-medium">{userName}</span> sent</>
                      ) : (
                        <>from <span className="text-fg font-medium">{m.fromAgentName}</span></>
                      )}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-fg-faint">
                    {timeAgo(m.createdAt)}
                    {m.urgent && <span className="ml-1.5 text-user">urgent</span>}
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
        {/* Recipient picker */}
        <div className="flex items-center gap-2 mb-2">
          <span className="text-[10px] text-fg-faint font-mono uppercase tracking-wider">To:</span>
          <select
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            className="text-[12px] font-mono bg-bg border border-border rounded px-2 py-1 text-fg focus:outline-none focus:border-user transition-colors"
          >
            {recipients.map((r) => (
              <option key={r.id} value={r.id}>{r.name}</option>
            ))}
          </select>
        </div>
        <div className="flex items-end gap-2">
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              recipient === "broadcast"
                ? "Broadcast to all agents..."
                : `Message ${recipients.find((r) => r.id === recipient)?.name ?? "agent"}...`
            }
            rows={1}
            className="flex-1 bg-bg border border-border rounded px-4 py-2.5 text-sm text-fg placeholder:text-fg-faint font-mono resize-none focus:outline-none focus:border-user transition-colors"
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
            className="bg-user text-white p-2.5 rounded disabled:opacity-30 cursor-pointer transition-opacity shrink-0"
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
// Dashboard Tab
// ---------------------------------------------------------------------------

function UserDashboardTab({ teamId, userName }: { teamId: string; userName: string }) {
  const [data, setData] = useState<HubData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchHub = async () => {
      try {
        const res = await fetch(`/api/team/${teamId}/agent-hub?agentId=${USER_AGENT_ID}`);
        if (res.ok && !cancelled) setData(await res.json());
      } catch { /* silent */ }
    };
    fetchHub();
    const interval = setInterval(fetchHub, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [teamId]);

  const sent = data?.timeline.filter((e) => e.type === "sent") ?? [];
  const received = data?.timeline.filter((e) => e.type === "received") ?? [];
  const uniqueAgents = new Set([
    ...received.map((e) => e.fromName).filter(Boolean),
    ...sent.map((e) => e.toName).filter(Boolean),
  ]);

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="space-y-6">
        {/* Stats grid */}
        <div className="grid grid-cols-3 gap-3">
          <UserStatCard label="Messages Sent" value={String(sent.length)} />
          <UserStatCard label="Messages Received" value={String(received.length)} />
          <UserStatCard label="Agents Connected" value={String(uniqueAgents.size)} />
        </div>

        {/* Recent activity */}
        {data && data.timeline.length > 0 && (
          <div>
            <div className="text-[9px] text-fg-faint font-mono uppercase tracking-[1.5px] mb-2">Recent Activity</div>
            <div className="space-y-1.5">
              {data.timeline.slice(-8).reverse().map((entry) => (
                <div key={entry.id} className="flex items-baseline gap-2 text-[12px] font-mono">
                  <span className="text-fg-faint shrink-0">{formatTime(entry.timestamp)}</span>
                  <span className="text-fg-muted truncate">
                    {entry.type === "sent"
                      ? `sent to ${entry.toName}`
                      : entry.type === "received"
                        ? `from ${entry.fromName}`
                        : entry.actionType?.replace(/_/g, " ") ?? "action"}
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

function UserStatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-border rounded px-4 py-3 bg-bg">
      <div className="text-[9px] text-fg-faint font-mono uppercase tracking-[1.5px]">{label}</div>
      <div className="text-[18px] font-semibold tracking-tight text-fg mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-fg-faint font-mono mt-0.5">{sub}</div>}
    </div>
  );
}

