"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DEFAULT_META_AGENT_PROMPT } from "@simple-harmonic/backend/lib/meta-agent/default-prompt";
import {
  COFOUNDER_AGENT_ID,
  DEFAULT_COFOUNDER_NAME,
  USER_AGENT_ID,
  resolveCofounderName,
} from "@simple-harmonic/backend/lib/meta-agent/identity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface MetaAgentPanelProps {
  teamId: string;
  teamName: string;
  metaAgentPrompt: string | null;
  cofounderName: string | null;
  onClose: () => void;
  onUpdated: (updates: { name: string; metaAgentPrompt: string | null; cofounderName: string | null }) => void;
  inline?: boolean;
}

type MetaTab = "dashboard" | "history" | "messages" | "config";

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[9px] text-fg-faint font-mono uppercase tracking-[1.5px] mb-1.5">
      {children}
    </label>
  );
}

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

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}...` : s;
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

export function MetaAgentPanel({ teamId, teamName, metaAgentPrompt, cofounderName, onClose, onUpdated, inline }: MetaAgentPanelProps) {
  const [tab, setTab] = useState<MetaTab>("dashboard");
  const resolvedName = resolveCofounderName(cofounderName);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const content = (
    <>
      {/* Header */}
      <div className="px-5 py-3.5 border-b border-border flex items-center gap-4 shrink-0 bg-bg">
        <div className="flex items-center gap-2.5">
          <span className="w-2.5 h-2.5 rounded-full bg-meta" />
          <span className="text-[16px] font-semibold text-fg">{resolvedName}</span>
        </div>
        <span className="text-[10px] text-fg-faint font-mono uppercase tracking-[1px] leading-snug">
          AI Cofounder
        </span>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-[10px] font-mono font-medium text-running uppercase tracking-[1px]">
            running
          </span>
          {!inline && (
            <button
              type="button"
              onClick={onClose}
              className="text-fg-faint hover:text-fg text-lg leading-none cursor-pointer"
            >
              &times;
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex items-center border-b border-border shrink-0 bg-bg-elev px-5">
        <div className="flex">
          {(["dashboard", "history", "messages", "config"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-[10px] font-mono uppercase tracking-wider cursor-pointer transition-colors ${
                tab === t
                  ? "text-fg border-b-2 border-meta"
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
        {tab === "dashboard" && (
          <MetaDashboardTab teamId={teamId} cofounderName={resolvedName} />
        )}
        {tab === "history" && (
          <MetaHistoryTab teamId={teamId} cofounderName={resolvedName} />
        )}
        {tab === "messages" && (
          <MetaMessagesTab teamId={teamId} cofounderName={resolvedName} />
        )}
        {tab === "config" && (
          <MetaConfigTab
            teamId={teamId}
            teamName={teamName}
            metaAgentPrompt={metaAgentPrompt}
            cofounderName={cofounderName}
            onUpdated={onUpdated}
            inline={inline}
          />
        )}
      </div>

      {/* Footer close (non-inline, non-config only) */}
      {!inline && tab !== "config" && (
        <div className="px-5 py-3 border-t border-border flex items-center justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-fg-muted hover:text-fg cursor-pointer px-3 py-1.5"
          >
            Close
          </button>
        </div>
      )}
    </>
  );

  if (inline) {
    return <div className="flex flex-col h-full bg-bg-elev">{content}</div>;
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 bottom-0 w-[480px] bg-bg-elev border-l border-border z-50 flex flex-col">
        {content}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Dashboard Tab
// ---------------------------------------------------------------------------

function MetaDashboardTab({ teamId, cofounderName }: { teamId: string; cofounderName: string }) {
  const [data, setData] = useState<HubData | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchHub = async () => {
      try {
        const res = await fetch(`/api/team/${teamId}/agent-hub?agentId=${COFOUNDER_AGENT_ID}`);
        if (res.ok && !cancelled) setData(await res.json());
      } catch { /* silent */ }
    };
    fetchHub();
    const interval = setInterval(fetchHub, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [teamId]);

  const totalEntries = data?.timeline.length ?? 0;

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="space-y-6">
        {/* Recent activity */}
        {data && totalEntries > 0 ? (
          <div>
            <div className="text-[9px] text-fg-faint font-mono uppercase tracking-[1.5px] mb-3">Recent Activity</div>
            <div className="space-y-1.5">
              {data.timeline.slice(-20).reverse().map((entry) => (
                <div key={entry.id} className="flex items-baseline gap-2 text-[12px] font-mono">
                  <span className="text-fg-faint shrink-0">{formatTime(entry.timestamp)}</span>
                  <span className="text-fg-muted truncate">
                    {entry.type === "sent"
                      ? `→ ${entry.toName}`
                      : entry.type === "received"
                        ? `← ${entry.fromName}`
                        : entry.actionType?.replace(/_/g, " ") ?? "action"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center py-12">
            <p className="text-xs text-fg-faint font-mono">No activity yet</p>
          </div>
        )}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// History Tab
// ---------------------------------------------------------------------------

function MetaHistoryTab({ teamId, cofounderName }: { teamId: string; cofounderName: string }) {
  const [data, setData] = useState<HubData | null>(null);
  const [loading, setLoading] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const prevCountRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const fetchHub = async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/team/${teamId}/agent-hub?agentId=${COFOUNDER_AGENT_ID}`);
        if (res.ok && !cancelled) setData(await res.json());
      } catch { /* silent */ }
      finally { if (!cancelled) setLoading(false); }
    };
    fetchHub();
    const interval = setInterval(fetchHub, 5000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [teamId]);

  useEffect(() => {
    const count = data?.timeline.length ?? 0;
    if (count > prevCountRef.current && prevCountRef.current > 0) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
    prevCountRef.current = count;
  }, [data?.timeline.length]);

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
          <p className="text-xs text-fg-faint font-mono">No activity yet</p>
          <p className="text-[11px] text-fg-faint mt-1">
            {cofounderName}'s interactions will appear here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-6 py-5">
      <div className="relative max-w-3xl">
        <div className="absolute left-[7px] top-3 bottom-3 w-px bg-border" />
        {data?.timeline.map((entry) => {
          if (entry.type === "sent") {
            return (
              <div key={entry.id} className="relative pl-8 pb-3">
                <div className="absolute left-[2px] top-[6px] w-[11px] h-[11px] rounded-full bg-meta" />
                <div className="flex items-baseline gap-2 py-1">
                  <span className="text-[10px] text-fg-faint font-mono shrink-0">
                    {formatTime(entry.timestamp)}
                  </span>
                  <span className="text-[13px] font-mono text-fg-muted">
                    &rarr; {entry.toName}: &ldquo;{truncate(entry.content, 100)}&rdquo;
                  </span>
                </div>
              </div>
            );
          }
          if (entry.type === "received") {
            return (
              <div key={entry.id} className="relative pl-8 pb-3">
                <div className="absolute left-[3px] top-[8px] w-[9px] h-[9px] rounded-full bg-fg-faint/30" />
                <div className="flex items-baseline gap-2 py-1">
                  <span className="text-[10px] text-fg-faint font-mono shrink-0">
                    {formatTime(entry.timestamp)}
                  </span>
                  <span className="text-[13px] font-mono text-fg-faint">
                    &larr; {entry.fromName}: &ldquo;{truncate(entry.content, 100)}&rdquo;
                  </span>
                </div>
              </div>
            );
          }
          return null;
        })}
        <div ref={endRef} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Messages Tab
// ---------------------------------------------------------------------------

function MetaMessagesTab({ teamId, cofounderName }: { teamId: string; cofounderName: string }) {
  const [messages, setMessages] = useState<A2AXMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const fetchMessages = useCallback(() => {
    setLoading(true);
    fetch(`/api/team/${teamId}/messages?agentId=${COFOUNDER_AGENT_ID}`)
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
      await fetch(`/api/team/${teamId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromAgentId: USER_AGENT_ID,
          toAgentId: COFOUNDER_AGENT_ID,
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

  const isFromCofounder = (m: A2AXMessage) => m.fromAgentId === COFOUNDER_AGENT_ID;

  return (
    <div className="flex flex-col h-full min-h-0">
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
                Send a message to {cofounderName} below.
              </p>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`border rounded px-4 py-3 ${
                  m.urgent ? "border-meta/40 bg-meta/5" : "border-border"
                } ${isFromCofounder(m) ? "bg-bg-elev" : "bg-bg"}`}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-2">
                    {channelBadge(m.channelType)}
                    <span className="text-[12px] font-mono text-fg-muted">
                      {isFromCofounder(m) ? (
                        <><span className="text-fg font-medium">{cofounderName}</span> sent</>
                      ) : (
                        <>from <span className="text-fg font-medium">{m.fromAgentName}</span></>
                      )}
                    </span>
                  </div>
                  <span className="text-[10px] font-mono text-fg-faint">
                    {timeAgo(m.createdAt)}
                    {m.urgent && <span className="ml-1.5 text-meta">urgent</span>}
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
            placeholder={`Message ${cofounderName} as You...`}
            rows={1}
            className="flex-1 bg-bg border border-border rounded px-4 py-2.5 text-sm text-fg placeholder:text-fg-faint font-mono resize-none focus:outline-none focus:border-meta transition-colors"
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
            className="bg-meta text-white p-2.5 rounded disabled:opacity-30 cursor-pointer transition-opacity shrink-0"
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

function MetaConfigTab({
  teamId,
  teamName,
  metaAgentPrompt,
  cofounderName,
  onUpdated,
  inline,
}: {
  teamId: string;
  teamName: string;
  metaAgentPrompt: string | null;
  cofounderName: string | null;
  onUpdated: (updates: { name: string; metaAgentPrompt: string | null; cofounderName: string | null }) => void;
  inline?: boolean;
}) {
  const [name, setName] = useState(teamName);
  const [prompt, setPrompt] = useState(metaAgentPrompt ?? DEFAULT_META_AGENT_PROMPT);
  const [cofounder, setCofounder] = useState(cofounderName ?? "");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setName(teamName);
    setPrompt(metaAgentPrompt ?? DEFAULT_META_AGENT_PROMPT);
    setCofounder(cofounderName ?? "");
    setDirty(false);
  }, [teamName, metaAgentPrompt, cofounderName]);

  const markDirty = useCallback(<T,>(setter: (v: T) => void) => {
    return (v: T) => { setter(v); setDirty(true); };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const cofounderTrimmed = cofounder.trim() || null;
      const res = await fetch(`/api/team/${teamId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          metaAgentPrompt: prompt.trim() || null,
          cofounderName: cofounderTrimmed,
        }),
      });
      if (res.ok) {
        onUpdated({
          name,
          metaAgentPrompt: prompt.trim() || null,
          cofounderName: cofounderTrimmed,
        });
        setDirty(false);
      }
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "w-full bg-bg border border-border rounded px-3 py-2 text-sm text-fg focus:outline-none focus:border-meta transition-colors";

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-5">
        <div>
          <FieldLabel>Team Name</FieldLabel>
          <input
            className={inputClass}
            value={name}
            onChange={(e) => markDirty(setName)(e.target.value)}
          />
        </div>

        <div>
          <FieldLabel>Cofounder Name</FieldLabel>
          <input
            className={inputClass}
            value={cofounder}
            onChange={(e) => markDirty(setCofounder)(e.target.value)}
            placeholder={DEFAULT_COFOUNDER_NAME}
          />
        </div>

        <div className="flex-1">
          <FieldLabel>System Prompt</FieldLabel>
          <textarea
            className={`${inputClass} min-h-[300px] font-mono text-xs leading-relaxed resize-y`}
            value={prompt}
            onChange={(e) => markDirty(setPrompt)(e.target.value)}
            placeholder="System prompt for the meta-agent..."
          />
        </div>
      </div>

      {dirty && (
        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-3 shrink-0 bg-bg-elev">
          <span className="text-[11px] text-fg-faint font-mono mr-auto">Unsaved changes</span>
          <button
            type="button"
            onClick={() => {
              setName(teamName);
              setPrompt(metaAgentPrompt ?? DEFAULT_META_AGENT_PROMPT);
              setCofounder(cofounderName ?? "");
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
            className="bg-meta text-white text-sm font-medium px-4 py-1.5 rounded disabled:opacity-40 cursor-pointer"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      )}
    </div>
  );
}
