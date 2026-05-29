"use client";

import { useCallback, useEffect, useState } from "react";

interface AgentDetail {
  id: string;
  name: string;
  role: string;
  archetype: string;
  tools: string[];
  scheduleSeconds: number;
  initialPrompt: string;
  status: "running" | "paused" | "errored";
}

interface AgentDetailPanelProps {
  agent: AgentDetail;
  teamId: string;
  teamAgents: { id: string; name: string }[];
  onClose: () => void;
  onUpdated: (agent: AgentDetail) => void;
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

const ARCHETYPES = [
  "support-responder",
  "content-scheduler",
  "sales-followup",
  "ops-monitor",
  "research-summarizer",
];

function formatSchedule(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[11px] text-fg-faint font-mono uppercase tracking-wider mb-1.5">
      {children}
    </label>
  );
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

export function AgentDetailPanel({ agent, teamId, teamAgents, onClose, onUpdated }: AgentDetailPanelProps) {
  const [tab, setTab] = useState<"config" | "messages">("config");

  // Config state
  const [name, setName] = useState(agent.name);
  const [role, setRole] = useState(agent.role);
  const [archetype, setArchetype] = useState(agent.archetype);
  const [toolsText, setToolsText] = useState(agent.tools.join(", "));
  const [scheduleSeconds, setScheduleSeconds] = useState(agent.scheduleSeconds);
  const [initialPrompt, setInitialPrompt] = useState(agent.initialPrompt);
  const [status, setStatus] = useState(agent.status);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  // Messages state
  const [messages, setMessages] = useState<A2AXMessage[]>([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [sendMode, setSendMode] = useState<"direct" | "broadcast">("direct");
  const [sendTo, setSendTo] = useState("");
  const [sendContent, setSendContent] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    setName(agent.name);
    setRole(agent.role);
    setArchetype(agent.archetype);
    setToolsText(agent.tools.join(", "));
    setScheduleSeconds(agent.scheduleSeconds);
    setInitialPrompt(agent.initialPrompt);
    setStatus(agent.status);
    setDirty(false);
    setTab("config");
  }, [agent]);

  const fetchMessages = useCallback(() => {
    setMsgLoading(true);
    fetch(`/api/team/${teamId}/messages?agentId=${agent.id}`)
      .then((r) => r.json())
      .then(setMessages)
      .catch(() => {})
      .finally(() => setMsgLoading(false));
  }, [teamId, agent.id]);

  // Fetch messages when messages tab is shown
  useEffect(() => {
    if (tab !== "messages") return;
    fetchMessages();
  }, [tab, fetchMessages]);

  const markDirty = useCallback(<T,>(setter: (v: T) => void) => {
    return (v: T) => { setter(v); setDirty(true); };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const tools = toolsText.split(",").map((t) => t.trim()).filter(Boolean);
      const res = await fetch(`/api/agent/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, role, archetype, tools, scheduleSeconds, initialPrompt, status }),
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

  const handleSendMessage = async () => {
    if (!sendContent.trim()) return;
    if (sendMode === "direct" && !sendTo) return;
    setSending(true);
    try {
      const body: Record<string, string> = {
        fromAgentId: agent.id,
        content: sendContent.trim(),
        channelType: sendMode,
      };
      if (sendMode === "direct") {
        body.toAgentId = sendTo;
      }
      const res = await fetch(`/api/team/${teamId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setSendContent("");
        fetchMessages();
      }
    } finally {
      setSending(false);
    }
  };

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const inputClass =
    "w-full bg-bg border border-border rounded px-3 py-2 text-sm text-fg focus:outline-none focus:border-brand transition-colors";

  const otherAgents = teamAgents.filter((a) => a.id !== agent.id);

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 bottom-0 w-[480px] bg-bg-elev border-l border-border z-50 flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold">{agent.name}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-faint hover:text-fg text-lg leading-none cursor-pointer"
          >
            &times;
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-border">
          <button
            type="button"
            onClick={() => setTab("config")}
            className={`flex-1 text-xs font-mono py-2.5 cursor-pointer transition-colors ${
              tab === "config"
                ? "text-fg border-b-2 border-brand"
                : "text-fg-faint hover:text-fg-muted"
            }`}
          >
            CONFIG
          </button>
          <button
            type="button"
            onClick={() => setTab("messages")}
            className={`flex-1 text-xs font-mono py-2.5 cursor-pointer transition-colors ${
              tab === "messages"
                ? "text-fg border-b-2 border-brand"
                : "text-fg-faint hover:text-fg-muted"
            }`}
          >
            MESSAGES
          </button>
        </div>

        {tab === "config" ? (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-5">
              <div>
                <FieldLabel>Name</FieldLabel>
                <input
                  className={inputClass}
                  value={name}
                  onChange={(e) => markDirty(setName)(e.target.value)}
                />
              </div>

              <div>
                <FieldLabel>Role</FieldLabel>
                <input
                  className={inputClass}
                  value={role}
                  onChange={(e) => markDirty(setRole)(e.target.value)}
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

              <div>
                <FieldLabel>Status</FieldLabel>
                <select
                  className={inputClass}
                  value={status}
                  onChange={(e) => markDirty(setStatus)(e.target.value as AgentDetail["status"])}
                >
                  <option value="running">running</option>
                  <option value="paused">paused</option>
                  <option value="errored">errored</option>
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
                    {formatSchedule(scheduleSeconds)}
                  </span>
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
                    {toolsText.split(",").map((t) => t.trim()).filter(Boolean).map((t) => (
                      <span key={t} className="text-[11px] font-mono bg-bg border border-border rounded px-2 py-0.5 text-fg-muted">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
              </div>

              <div className="flex-1">
                <FieldLabel>System Prompt</FieldLabel>
                <textarea
                  className={`${inputClass} min-h-[200px] font-mono text-xs leading-relaxed resize-y`}
                  value={initialPrompt}
                  onChange={(e) => markDirty(setInitialPrompt)(e.target.value)}
                />
              </div>
            </div>

            <div className="px-5 py-4 border-t border-border flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="text-sm text-fg-muted hover:text-fg cursor-pointer px-3 py-1.5"
              >
                Close
              </button>
              {dirty && (
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving}
                  className="bg-brand text-white text-sm font-medium px-4 py-1.5 rounded disabled:opacity-40 cursor-pointer"
                >
                  {saving ? "Saving..." : "Save"}
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-4">
              {/* Compose */}
              <div className="border border-border rounded-lg p-3 flex flex-col gap-2.5">
                <FieldLabel>Send as {agent.name}</FieldLabel>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSendMode("direct")}
                    className={`text-[11px] font-mono px-2.5 py-1 rounded cursor-pointer transition-colors ${
                      sendMode === "direct"
                        ? "bg-blue-500/15 text-blue-400 border border-blue-500/30"
                        : "text-fg-faint border border-border hover:text-fg-muted"
                    }`}
                  >
                    direct
                  </button>
                  <button
                    type="button"
                    onClick={() => setSendMode("broadcast")}
                    className={`text-[11px] font-mono px-2.5 py-1 rounded cursor-pointer transition-colors ${
                      sendMode === "broadcast"
                        ? "bg-amber-500/15 text-amber-400 border border-amber-500/30"
                        : "text-fg-faint border border-border hover:text-fg-muted"
                    }`}
                  >
                    broadcast
                  </button>
                </div>
                {sendMode === "direct" && (
                  <select
                    className={inputClass}
                    value={sendTo}
                    onChange={(e) => setSendTo(e.target.value)}
                  >
                    <option value="">Select recipient...</option>
                    {otherAgents.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                )}
                <textarea
                  className={`${inputClass} min-h-[60px] font-mono text-xs resize-y`}
                  value={sendContent}
                  onChange={(e) => setSendContent(e.target.value)}
                  placeholder="Message content..."
                />
                <button
                  type="button"
                  onClick={handleSendMessage}
                  disabled={!sendContent.trim() || (sendMode === "direct" && !sendTo) || sending}
                  className="self-end bg-brand text-white text-xs font-medium px-3 py-1.5 rounded disabled:opacity-40 cursor-pointer"
                >
                  {sending ? "Sending..." : sendMode === "broadcast" ? "Broadcast" : "Send"}
                </button>
              </div>

              {/* Inbox */}
              <FieldLabel>Inbox</FieldLabel>
              {msgLoading ? (
                <p className="text-xs text-fg-faint font-mono">loading...</p>
              ) : messages.length === 0 ? (
                <p className="text-xs text-fg-faint font-mono">no messages yet</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      className={`border rounded-lg px-3 py-2.5 ${
                        m.urgent ? "border-brand/40 bg-brand/5" : "border-border"
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2">
                          {channelBadge(m.channelType)}
                          <span className="text-xs font-mono text-fg-muted">
                            from <span className="text-fg">{m.fromAgentName}</span>
                          </span>
                        </div>
                        <span className="text-[10px] font-mono text-fg-faint">
                          {timeAgo(m.createdAt)}
                          {m.urgent && <span className="ml-1.5 text-brand">urgent</span>}
                        </span>
                      </div>
                      <p className="text-xs text-fg leading-relaxed">{m.content}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="px-5 py-4 border-t border-border flex items-center justify-end">
              <button
                type="button"
                onClick={onClose}
                className="text-sm text-fg-muted hover:text-fg cursor-pointer px-3 py-1.5"
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
