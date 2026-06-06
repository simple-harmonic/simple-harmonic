"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  COFOUNDER_AGENT_ID,
  USER_AGENT_ID,
  getTeamHumans,
  resolveCofounderName,
} from "@simple-harmonic/backend/lib/meta-agent/identity";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ThreadMessage {
  id: string;
  fromAgentId: string;
  fromAgentName: string;
  content: string;
  kind: string;
  status: string;
  urgent: boolean;
  createdAt: string;
  isSelf: boolean;
}

interface Thread {
  channelId: string;
  channelType: "direct" | "broadcast" | "group" | "task";
  peerAgentId: string | null;
  peerAgentName: string | null;
  messages: ThreadMessage[];
}

interface ConversationsResponse {
  agentId: string;
  agentName: string;
  threads: Thread[];
}

interface TaskItem {
  id: string;
  title: string;
  description: string;
  state: string;
  requestorId: string;
  requestorName: string;
  assigneeId: string;
  assigneeName: string;
  createdAt: string;
  updatedAt: string;
}

interface AgentInfo {
  id: string;
  name: string;
  role: string;
  status: "running" | "paused" | "errored" | "awaiting_approval";
}

interface AgentMessagesViewProps {
  teamId: string;
  cofounderName: string | null;
  agents: AgentInfo[];
  initialPovId?: string;
  onClose: () => void;
}

type ActiveTab = "messages" | "tasks";

// Special POV IDs
const POV_TEAM = "team";
const POV_COFOUNDER = "cofounder";
const POV_USER = "user";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  });
}

function statusDot(status: AgentInfo["status"]) {
  const color =
    status === "running"
      ? "bg-running"
      : status === "paused"
        ? "bg-paused"
        : status === "awaiting_approval"
          ? "bg-brand"
          : "bg-error";
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />;
}

function channelIcon(type: Thread["channelType"]) {
  switch (type) {
    case "direct":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
        </svg>
      );
    case "broadcast":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
          <line x1="4" y1="22" x2="4" y2="15" />
        </svg>
      );
    case "group":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
          <path d="M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "task":
      return (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 11l3 3L22 4" />
          <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
        </svg>
      );
  }
}

const TASK_STATE_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  submitted: { bg: "bg-yellow-500/10", text: "text-yellow-400", label: "Submitted" },
  accepted: { bg: "bg-blue-500/10", text: "text-blue-400", label: "Accepted" },
  working: { bg: "bg-brand/10", text: "text-brand", label: "Working" },
  input_required: { bg: "bg-purple-500/10", text: "text-purple-400", label: "Needs Input" },
  completed: { bg: "bg-green-500/10", text: "text-green-400", label: "Completed" },
  failed: { bg: "bg-red-500/10", text: "text-red-400", label: "Failed" },
  canceled: { bg: "bg-neutral-500/10", text: "text-neutral-400", label: "Canceled" },
  rejected: { bg: "bg-red-500/10", text: "text-red-400", label: "Rejected" },
};

function TaskStateBadge({ state }: { state: string }) {
  const style = TASK_STATE_STYLES[state] ?? TASK_STATE_STYLES.submitted;
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-medium ${style.bg} ${style.text}`}>
      {style.label}
    </span>
  );
}

function getPovLabel(povId: string, agents: AgentInfo[], cofounderDisplay: string): string {
  if (povId === POV_TEAM) return "Team Overview";
  if (povId === POV_COFOUNDER) return cofounderDisplay;
  if (povId === POV_USER) return "You";
  return agents.find((a) => a.id === povId)?.name ?? povId;
}

function getPovRole(povId: string, agents: AgentInfo[]): string {
  if (povId === POV_TEAM) return "every message in the team";
  if (povId === POV_COFOUNDER) return "AI cofounder";
  if (povId === POV_USER) return "human in the loop";
  return agents.find((a) => a.id === povId)?.role ?? "agent";
}

function getPovInitial(povId: string, agents: AgentInfo[], cofounderDisplay: string): string {
  if (povId === POV_TEAM) return "F";
  if (povId === POV_COFOUNDER) return cofounderDisplay.charAt(0).toUpperCase();
  if (povId === POV_USER) return "Y";
  return (agents.find((a) => a.id === povId)?.name ?? "?").charAt(0).toUpperCase();
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentMessagesView({ teamId, cofounderName, agents, initialPovId, onClose }: AgentMessagesViewProps) {
  const cofounderDisplay = resolveCofounderName(cofounderName);
  const humans = getTeamHumans(teamId);
  const [povId, setPovId] = useState(initialPovId ?? POV_USER);
  const [activeTab, setActiveTab] = useState<ActiveTab>("messages");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [selectedThread, setSelectedThread] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Compose state
  const [composeContent, setComposeContent] = useState("");
  const [sending, setSending] = useState(false);
  // Tracks the agent id currently undergoing a wake/pause action (for button disable)
  const [actionPending, setActionPending] = useState<string | null>(null);
  const [actionFlash, setActionFlash] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Team Overview is read-only (no compose, sees all). Cofounder is a participant.
  const isTeamOverview = povId === POV_TEAM;
  const isSpecialPov = isTeamOverview;

  // Fetch conversations
  const fetchConversations = useCallback(async (id: string) => {
    if (!id) return;
    setLoading(true);
    try {
      const res = await fetch(`/api/team/${teamId}/conversations?agentId=${id}`);
      const data: ConversationsResponse = await res.json();
      setThreads((prev) => {
        const apiIds = new Set(data.threads.map((t) => t.channelId));
        const placeholders = prev.filter(
          (t) => t.messages.length === 0 && !apiIds.has(t.channelId),
        );
        return [...data.threads, ...placeholders];
      });
      if (data.threads.length > 0 && !selectedThread) {
        setSelectedThread(data.threads[0].channelId);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, [teamId, selectedThread]);

  // Fetch tasks
  const fetchTasks = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/team/${teamId}/tasks?agentId=${id}`);
      const data: TaskItem[] = await res.json();
      setTasks(data);
    } catch {
      // silent
    }
  }, [teamId]);

  useEffect(() => {
    fetchConversations(povId);
    fetchTasks(povId);
    const interval = setInterval(() => {
      fetchConversations(povId);
      fetchTasks(povId);
    }, 5000);
    return () => clearInterval(interval);
  }, [povId, fetchConversations, fetchTasks]);

  const activeThread = threads.find((t) => t.channelId === selectedThread);
  const activeTaskItem = tasks.find((t) => t.id === selectedTask);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [activeThread?.messages.length, selectedThread]);

  const handleSend = async () => {
    if (!composeContent.trim() || !activeThread || !canCompose) return;
    setSending(true);
    try {
      const body: Record<string, string> = {
        fromAgentId: povId,
        content: composeContent.trim(),
        channelType: activeThread.channelType,
      };
      if (activeThread.channelType === "direct" && activeThread.peerAgentId) {
        body.toAgentId = activeThread.peerAgentId;
      }
      if (activeThread.channelType === "group") {
        body.channelId = activeThread.channelId;
      }
      await fetch(`/api/team/${teamId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      setComposeContent("");
      await fetchConversations(povId);
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

  const handleWakeAgent = async (agentId: string) => {
    setActionPending(agentId);
    try {
      const res = await fetch(`/api/agent/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ wake: true }),
      });
      if (res.ok) {
        setActionFlash(`Woke ${agents.find((a) => a.id === agentId)?.name ?? "agent"} for the next tick.`);
        setTimeout(() => setActionFlash(null), 3000);
      }
    } finally {
      setActionPending(null);
    }
  };

  const handleToggleAgentStatus = async (agent: AgentInfo) => {
    const nextStatus = agent.status === "paused" ? "running" : "paused";
    setActionPending(agent.id);
    try {
      const res = await fetch(`/api/agent/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: nextStatus }),
      });
      if (res.ok) {
        setActionFlash(`${nextStatus === "paused" ? "Paused" : "Resumed"} ${agent.name}.`);
        setTimeout(() => setActionFlash(null), 3000);
      }
    } finally {
      setActionPending(null);
    }
  };

  // Map POV sentinel to the participant's real UUID (for channelId computation).
  const realParticipantId =
    povId === POV_USER
      ? USER_AGENT_ID
      : povId === POV_COFOUNDER
        ? COFOUNDER_AGENT_ID
        : povId;

  const handleNewDM = (peerId: string) => {
    const existing = threads.find(
      (t) => t.channelType === "direct" && t.peerAgentId === peerId,
    );
    if (existing) {
      setSelectedThread(existing.channelId);
    } else {
      const peerName =
        peerId === COFOUNDER_AGENT_ID
          ? cofounderDisplay
          : agents.find((a) => a.id === peerId)?.name ?? peerId;
      const ids = [realParticipantId, peerId].sort();
      const channelId = `direct:${ids[0]}:${ids[1]}`;
      setThreads((prev) => [
        {
          channelId,
          channelType: "direct",
          peerAgentId: peerId,
          peerAgentName: peerName,
          messages: [],
        },
        ...prev,
      ]);
      setSelectedThread(channelId);
    }
  };

  const handleNewBroadcast = () => {
    const existing = threads.find((t) => t.channelType === "broadcast");
    if (existing) {
      setSelectedThread(existing.channelId);
    } else {
      const channelId = `broadcast:${teamId}`;
      setThreads((prev) => [
        {
          channelId,
          channelType: "broadcast",
          peerAgentId: null,
          peerAgentName: "Team Broadcast",
          messages: [],
        },
        ...prev,
      ]);
      setSelectedThread(channelId);
    }
  };

  const handlePovChange = (newPov: string) => {
    setPovId(newPov);
    setSelectedThread(null);
    setSelectedTask(null);
    setThreads([]);
    setTasks([]);
  };

  // Peers the current POV can DM. For human/cofounder POVs, peers include each
  // other plus all agents. For an agent POV, peers include other agents + the
  // cofounder + the user.
  const peers: AgentInfo[] = (() => {
    if (povId === POV_USER) {
      return [
        { id: COFOUNDER_AGENT_ID, name: cofounderDisplay, role: "AI cofounder", status: "running" as const },
        ...agents,
      ];
    }
    if (povId === POV_COFOUNDER) {
      return [
        { id: USER_AGENT_ID, name: "You", role: "human in the loop", status: "running" as const },
        ...agents,
      ];
    }
    return [
      { id: USER_AGENT_ID, name: "You", role: "human in the loop", status: "running" as const },
      { id: COFOUNDER_AGENT_ID, name: cofounderDisplay, role: "AI cofounder", status: "running" as const },
      ...agents.filter((a) => a.id !== povId),
    ];
  })();
  const threadsWithoutPeers = isSpecialPov
    ? []
    : peers.filter(
        (p) => !threads.some((t) => t.channelType === "direct" && t.peerAgentId === p.id),
      );

  // Task counts for the tab badge
  const activeTaskCount = tasks.filter((t) =>
    ["submitted", "accepted", "working", "input_required"].includes(t.state),
  ).length;

  const canCompose = povId === POV_USER;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Main area: sidebar + content */}
      <div className="flex-1 flex min-h-0">
        {/* Thread/Task list sidebar */}
        <div className="w-[260px] border-r border-border bg-bg flex flex-col min-h-0 shrink-0">


          {/* Tabs: Messages / Tasks */}
          <div className="flex border-b border-border shrink-0">
            <button
              type="button"
              onClick={() => setActiveTab("messages")}
              className={`flex-1 py-2 text-[11px] font-mono uppercase tracking-wider text-center cursor-pointer transition-colors ${
                activeTab === "messages"
                  ? "text-fg border-b-2 border-brand"
                  : "text-fg-faint hover:text-fg-muted"
              }`}
            >
              Messages
              {threads.length > 0 && (
                <span className="ml-1.5 text-fg-faint">{threads.length}</span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("tasks")}
              className={`flex-1 py-2 text-[11px] font-mono uppercase tracking-wider text-center cursor-pointer transition-colors ${
                activeTab === "tasks"
                  ? "text-fg border-b-2 border-brand"
                  : "text-fg-faint hover:text-fg-muted"
              }`}
            >
              Tasks
              {activeTaskCount > 0 && (
                <span className="ml-1.5 bg-brand text-white text-[9px] font-bold rounded-full px-1.5 py-0.5">
                  {activeTaskCount}
                </span>
              )}
            </button>
          </div>

          {/* List content */}
          <div className="flex-1 overflow-y-auto">
            {activeTab === "messages" ? (
              <>
                {loading && threads.length === 0 ? (
                  <div className="px-4 py-6 text-xs text-fg-faint font-mono">loading...</div>
                ) : (
                  <>
                    {threads.map((thread) => {
                      const lastMsg = thread.messages[thread.messages.length - 1];
                      const isActive = selectedThread === thread.channelId && activeTab === "messages";
                      const unreadCount = thread.messages.filter(
                        (m) => !m.isSelf && m.status === "pending",
                      ).length;

                      return (
                        <button
                          key={thread.channelId}
                          type="button"
                          onClick={() => {
                            setSelectedThread(thread.channelId);
                            setSelectedTask(null);
                          }}
                          className={`w-full text-left px-4 py-3 border-b border-border cursor-pointer transition-colors ${
                            isActive ? "bg-bg-elev" : "hover:bg-bg-elev/50"
                          }`}
                        >
                          <div className="flex items-center justify-between mb-1">
                            <div className="flex items-center gap-1.5">
                              <span className="text-fg-faint">{channelIcon(thread.channelType)}</span>
                              <span className="text-sm font-medium text-fg truncate max-w-[150px]">
                                {thread.peerAgentName ?? thread.channelId}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5">
                              {unreadCount > 0 && (
                                <span className="bg-brand text-white text-[10px] font-bold rounded-full w-4 h-4 flex items-center justify-center">
                                  {unreadCount}
                                </span>
                              )}
                              {lastMsg && (
                                <span className="text-[10px] text-fg-faint font-mono">
                                  {timeAgo(lastMsg.createdAt)}
                                </span>
                              )}
                            </div>
                          </div>
                          {lastMsg && (
                            <p className="text-xs text-fg-muted truncate">
                              {isSpecialPov ? `${lastMsg.fromAgentName}: ` : lastMsg.isSelf ? "You: " : ""}
                              {lastMsg.content}
                            </p>
                          )}
                        </button>
                      );
                    })}

                    {/* New conversation (human user only) */}
                    {canCompose && threadsWithoutPeers.length > 0 && (
                      <div className="px-4 py-3 border-t border-border">
                        <span className="text-[10px] text-fg-faint font-mono uppercase tracking-wider">
                          Direct message
                        </span>
                        <div className="flex flex-col gap-0.5 mt-2">
                          {threadsWithoutPeers.map((a) => (
                            <button
                              key={a.id}
                              type="button"
                              onClick={() => handleNewDM(a.id)}
                              className="flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-bg-elev cursor-pointer transition-colors"
                            >
                              {statusDot(a.status)}
                              <span className="text-xs text-fg-muted">{a.name}</span>
                            </button>
                          ))}
                        </div>
                        <div className="mt-3 flex flex-col gap-0.5">
                          <span className="text-[10px] text-fg-faint font-mono uppercase tracking-wider mb-1">
                            Team
                          </span>
                          {!threads.some((t) => t.channelType === "broadcast") && (
                            <button
                              type="button"
                              onClick={() => handleNewBroadcast()}
                              className="flex items-center gap-2 px-2 py-1.5 rounded text-left hover:bg-bg-elev cursor-pointer transition-colors"
                            >
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-fg-faint">
                                <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                                <line x1="4" y1="22" x2="4" y2="15" />
                              </svg>
                              <span className="text-xs text-fg-muted">Broadcast to all</span>
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                    {canCompose && threads.length === 0 && threadsWithoutPeers.length === 0 && !loading && (
                      <div className="px-4 py-6">
                        <p className="text-xs text-fg-faint font-mono">No conversations yet</p>
                        <p className="text-[11px] text-fg-faint mt-1">
                          Start a conversation with an agent below.
                        </p>
                      </div>
                    )}
                    {!canCompose && threads.length === 0 && !loading && (
                      <div className="px-4 py-6">
                        <p className="text-xs text-fg-faint font-mono">No messages yet</p>
                        <p className="text-[11px] text-fg-faint mt-1">
                          Messages will appear here as agents communicate.
                        </p>
                      </div>
                    )}
                  </>
                )}
              </>
            ) : (
              /* Tasks list */
              <>
                {tasks.length === 0 ? (
                  <div className="px-4 py-6">
                    <p className="text-xs text-fg-faint font-mono">No tasks yet</p>
                    <p className="text-[11px] text-fg-faint mt-1">
                      Tasks created between agents will appear here.
                    </p>
                  </div>
                ) : (
                  tasks.map((task) => {
                    const isActive = selectedTask === task.id && activeTab === "tasks";
                    return (
                      <button
                        key={task.id}
                        type="button"
                        onClick={() => {
                          setSelectedTask(task.id);
                          setSelectedThread(null);
                        }}
                        className={`w-full text-left px-4 py-3 border-b border-border cursor-pointer transition-colors ${
                          isActive ? "bg-bg-elev" : "hover:bg-bg-elev/50"
                        }`}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium text-fg truncate max-w-[160px]">
                            {task.title}
                          </span>
                          <TaskStateBadge state={task.state} />
                        </div>
                        <div className="text-[10px] text-fg-faint font-mono">
                          {task.requestorName} → {task.assigneeName}
                        </div>
                      </button>
                    );
                  })
                )}
              </>
            )}
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 flex flex-col min-h-0 bg-bg">
          {activeTab === "messages" && activeThread ? (
            <>
              {/* Thread header */}
              <div className="px-5 py-3 border-b border-border flex items-center gap-3 shrink-0 bg-bg-elev">
                <span className="text-fg-faint">{channelIcon(activeThread.channelType)}</span>
                <div className="flex-1">
                  <div className="text-sm font-medium text-fg">
                    {activeThread.peerAgentName ?? activeThread.channelId}
                  </div>
                  <div className="text-[10px] text-fg-faint font-mono">
                    {activeThread.channelType}
                    {activeThread.messages.length > 0 && ` · ${activeThread.messages.length} messages`}
                  </div>
                </div>
                {/* Human-in-the-loop controls: only when User is acting on a real agent */}
                {povId === POV_USER && activeThread.channelType === "direct" && activeThread.peerAgentId && (() => {
                  const peerAgent = agents.find((a) => a.id === activeThread.peerAgentId);
                  if (!peerAgent) return null;
                  const blockedByApproval = peerAgent.status === "awaiting_approval";
                  return (
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleWakeAgent(peerAgent.id)}
                        disabled={actionPending === peerAgent.id || blockedByApproval}
                        title={blockedByApproval ? "Resolve the pending approval first" : "Schedule this agent to run on the next tick"}
                        className="text-[11px] font-mono px-2 py-1 rounded border border-border text-fg-muted hover:text-fg hover:border-brand cursor-pointer transition-colors disabled:opacity-50"
                      >
                        Wake
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleAgentStatus(peerAgent)}
                        disabled={actionPending === peerAgent.id || blockedByApproval}
                        title={blockedByApproval ? "Resolve the pending approval first" : peerAgent.status === "paused" ? "Resume this agent" : "Pause this agent"}
                        className="text-[11px] font-mono px-2 py-1 rounded border border-border text-fg-muted hover:text-fg hover:border-brand cursor-pointer transition-colors disabled:opacity-50"
                      >
                        {blockedByApproval ? "Awaiting" : peerAgent.status === "paused" ? "Resume" : "Pause"}
                      </button>
                    </div>
                  );
                })()}
              </div>

              {actionFlash && (
                <div className="px-5 py-2 border-b border-border bg-brand/10 text-brand text-[11px] font-mono shrink-0">
                  {actionFlash}
                </div>
              )}

              {/* Messages */}
              <div className="flex-1 overflow-y-auto px-5 py-4">
                {activeThread.messages.length === 0 ? (
                  <div className="flex items-center justify-center h-full">
                    <p className="text-xs text-fg-faint font-mono">
                      No messages yet. Send one below.
                    </p>
                  </div>
                ) : (
                  <div className="flex flex-col gap-1">
                    {activeThread.messages.map((msg, i) => {
                      const prev = activeThread.messages[i - 1];
                      const showTimestamp =
                        !prev ||
                        new Date(msg.createdAt).getTime() - new Date(prev.createdAt).getTime() > 300000;
                      const showName = !prev || prev.fromAgentId !== msg.fromAgentId;

                      if (isSpecialPov) {
                        return (
                          <div key={msg.id}>
                            {showTimestamp && (
                              <div className="flex justify-center my-3">
                                <span className="text-[10px] text-fg-faint font-mono bg-bg-elev px-2 py-0.5 rounded">
                                  {formatTime(msg.createdAt)}
                                </span>
                              </div>
                            )}
                            <div className="flex justify-start">
                              <div className="max-w-[85%]">
                                {showName && (
                                  <span className="text-[10px] text-brand font-mono ml-3 mb-0.5 block">
                                    {msg.fromAgentName}
                                  </span>
                                )}
                                <div className={`px-3.5 py-2 rounded-2xl text-[13px] leading-relaxed bg-bg-elev text-fg border border-border rounded-bl-md ${msg.urgent ? "ring-1 ring-brand/50" : ""}`}>
                                  {msg.content}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      return (
                        <div key={msg.id}>
                          {showTimestamp && (
                            <div className="flex justify-center my-3">
                              <span className="text-[10px] text-fg-faint font-mono bg-bg-elev px-2 py-0.5 rounded">
                                {formatTime(msg.createdAt)}
                              </span>
                            </div>
                          )}
                          <div
                            className={`flex ${msg.isSelf ? "justify-end" : "justify-start"}`}
                          >
                            <div className={`max-w-[75%] ${msg.isSelf ? "items-end" : "items-start"}`}>
                              {showName && !msg.isSelf && (
                                <span className="text-[10px] text-fg-faint font-mono ml-3 mb-0.5 block">
                                  {msg.fromAgentName}
                                </span>
                              )}
                              <div
                                className={`px-3.5 py-2 rounded-2xl text-[13px] leading-relaxed ${
                                  msg.isSelf
                                    ? "bg-brand text-white rounded-br-md"
                                    : "bg-bg-elev text-fg border border-border rounded-bl-md"
                                } ${msg.urgent ? "ring-1 ring-brand/50" : ""}`}
                              >
                                {msg.content}
                              </div>
                              {msg.kind !== "text" && (
                                <span className="text-[9px] text-fg-faint font-mono ml-3 mt-0.5 block">
                                  {msg.kind}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                    <div ref={messagesEndRef} />
                  </div>
                )}
              </div>

              {/* Compose (only for human user) */}
              {canCompose && (
                <div className="px-4 py-3 border-t border-border shrink-0 bg-bg-elev">
                  <div className="flex items-end gap-2">
                    <textarea
                      value={composeContent}
                      onChange={(e) => setComposeContent(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder={`Message as ${getPovLabel(povId, agents, cofounderDisplay)}...`}
                      rows={1}
                      className="flex-1 bg-bg border border-border rounded-xl px-4 py-2.5 text-sm text-fg placeholder:text-fg-faint font-mono resize-none focus:outline-none focus:border-brand transition-colors"
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
                      disabled={!composeContent.trim() || sending}
                      className="bg-brand text-white p-2.5 rounded-xl disabled:opacity-30 cursor-pointer transition-opacity shrink-0"
                    >
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="22" y1="2" x2="11" y2="13" />
                        <polygon points="22 2 15 22 11 13 2 9 22 2" />
                      </svg>
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : activeTab === "tasks" && activeTaskItem ? (
            /* Task detail */
            <div className="flex-1 overflow-y-auto">
              <div className="px-6 py-5">
                <div className="flex items-start justify-between mb-4">
                  <h2 className="text-lg font-semibold text-fg pr-4">{activeTaskItem.title}</h2>
                  <TaskStateBadge state={activeTaskItem.state} />
                </div>

                <div className="grid grid-cols-2 gap-4 mb-6">
                  <div>
                    <span className="text-[10px] text-fg-faint font-mono uppercase tracking-wider block mb-1">
                      Requested by
                    </span>
                    <span className="text-sm text-fg">{activeTaskItem.requestorName}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-fg-faint font-mono uppercase tracking-wider block mb-1">
                      Assigned to
                    </span>
                    <span className="text-sm text-fg">{activeTaskItem.assigneeName}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-fg-faint font-mono uppercase tracking-wider block mb-1">
                      Created
                    </span>
                    <span className="text-sm text-fg-muted font-mono">{formatTime(activeTaskItem.createdAt)}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-fg-faint font-mono uppercase tracking-wider block mb-1">
                      Updated
                    </span>
                    <span className="text-sm text-fg-muted font-mono">{formatTime(activeTaskItem.updatedAt)}</span>
                  </div>
                </div>

                <div>
                  <span className="text-[10px] text-fg-faint font-mono uppercase tracking-wider block mb-2">
                    Description
                  </span>
                  <div className="bg-bg-elev border border-border rounded-lg px-4 py-3 text-sm text-fg leading-relaxed">
                    {activeTaskItem.description}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="text-fg-faint mb-2">
                  {activeTab === "messages" ? (
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto">
                      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                    </svg>
                  ) : (
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="mx-auto">
                      <path d="M9 11l3 3L22 4" />
                      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                    </svg>
                  )}
                </div>
                <p className="text-xs text-fg-faint font-mono">
                  {activeTab === "messages" ? "Select a conversation" : "Select a task"}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
