"use client";

import Link from "next/link";
import type { NarrationEntry } from "../../lib/narration";

interface Agent {
  id: string;
  name: string;
  role: string;
  status: "running" | "paused" | "errored" | "awaiting_approval";
  inFlight: boolean;
  scheduleSeconds: number;
}

interface ChildAgent extends Agent {
  teamId: string;
}

interface ChildTeam {
  id: string;
  name: string;
  parentTeamId: string | null;
  paused: boolean;
}

interface TeamDashboardProps {
  teamId: string;
  agents: Agent[];
  childTeams?: ChildTeam[];
  childAgents?: ChildAgent[];
  narration: NarrationEntry[];
  tickCount: number;
  paused: boolean;
  onAgentClick: (id: string) => void;
}

function formatSchedule(s: number): string {
  if (s >= 3600) return `${Math.round(s / 3600)}h`;
  if (s >= 60) return `${Math.round(s / 60)}m`;
  return `${s}s`;
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const date = d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  return `${date} ${time}`;
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

const STATUS_STYLE: Record<string, { dot: string; label: string }> = {
  running: { dot: "bg-running", label: "running" },
  paused: { dot: "bg-paused", label: "paused" },
  errored: { dot: "bg-error", label: "errored" },
  awaiting_approval: { dot: "bg-brand", label: "awaiting approval" },
};

export function TeamDashboard({
  teamId,
  agents,
  childTeams = [],
  childAgents = [],
  narration,
  tickCount,
  paused,
  onAgentClick,
}: TeamDashboardProps) {
  const allAgents = [...agents, ...childAgents];
  const running = allAgents.filter((a) => a.status === "running").length;
  const errored = allAgents.filter((a) => a.status === "errored").length;
  const awaiting = allAgents.filter((a) => a.status === "awaiting_approval").length;
  const tokensUp = tickCount * 400;
  const tokensDown = tickCount * 1200;
  const cost = (tokensUp * 3 + tokensDown * 15) / 1_000_000;

  const hasSubTeams = childTeams.length > 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[960px] mx-auto px-6 py-6">
        {/* Stats row */}
        <div className="grid grid-cols-5 gap-3 mb-8">
          <StatCard label="Agents" value={String(allAgents.length)} sub={`${running} running`} />
          <StatCard label="Ticks" value={String(tickCount)} />
          <StatCard label="Tokens In" value={fmt(tokensUp)} />
          <StatCard label="Tokens Out" value={fmt(tokensDown)} />
          <StatCard label="Est. Cost" value={`$${cost.toFixed(2)}`} />
        </div>

        <div className="grid grid-cols-[1fr_380px] gap-6">
          {/* Agent cards */}
          <div>
            <h2 className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono mb-3">
              Agents
            </h2>

            {/* Direct agents */}
            {agents.length > 0 && (
              <div className="flex flex-col gap-2 mb-4">
                {agents.map((agent) => (
                  <AgentCard key={agent.id} agent={agent} onClick={() => onAgentClick(agent.id)} />
                ))}
              </div>
            )}

            {/* Sub-team agents */}
            {hasSubTeams && (
              <div className="flex flex-col gap-4">
                {childTeams.map((ct) => {
                  const teamChildAgents = childAgents.filter((a) => a.teamId === ct.id);
                  if (teamChildAgents.length === 0) return null;
                  return (
                    <div key={ct.id}>
                      <Link
                        href={`/f/${ct.id}`}
                        className="flex items-center gap-2 mb-2 group"
                      >
                        <span className={`w-1.5 h-1.5 rounded-full ${ct.paused ? "bg-paused" : "bg-running"}`} />
                        <span className="text-[11px] font-semibold text-fg-muted font-mono uppercase tracking-[0.06em] group-hover:text-brand transition-colors">
                          {ct.name}
                        </span>
                        <span className="text-[10px] text-fg-faint font-mono">
                          {teamChildAgents.length} agent{teamChildAgents.length !== 1 ? "s" : ""}
                        </span>
                      </Link>
                      <div className="flex flex-col gap-2 ml-3 border-l border-border/50 pl-3">
                        {teamChildAgents.map((agent) => (
                          <AgentCard
                            key={agent.id}
                            agent={agent}
                            onClick={() => {
                              window.location.href = `/f/${ct.id}?agent=${agent.id}`;
                            }}
                          />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {agents.length === 0 && !hasSubTeams && (
              <div className="text-[12px] text-fg-faint font-mono py-4 text-center">No agents in this team</div>
            )}

            {/* Summary row */}
            {(errored > 0 || awaiting > 0) && (
              <div className="flex gap-3 mt-3">
                {errored > 0 && (
                  <span className="text-[11px] font-mono text-error bg-error/10 px-2 py-1 rounded">
                    {errored} errored
                  </span>
                )}
                {awaiting > 0 && (
                  <span className="text-[11px] font-mono text-brand bg-brand/10 px-2 py-1 rounded">
                    {awaiting} awaiting approval
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Activity feed */}
          <div data-testid="narration-feed">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono">
                Activity
              </h2>
              {!paused && (
                <span className="flex items-center gap-1.5 text-[10px] text-running font-mono">
                  <span className="w-1.5 h-1.5 rounded-full bg-running animate-pulse" />
                  live
                </span>
              )}
            </div>
            <div className="border border-border rounded-[10px] bg-bg-elev overflow-hidden">
              <div className="max-h-[500px] overflow-y-auto">
                {narration.length === 0 ? (
                  <div className="px-4 py-8 text-center text-[12px] text-fg-faint font-mono">
                    {paused ? "Team is paused. Resume to see activity." : "Waiting for first tick..."}
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {narration.slice(0, 30).map((entry) => (
                      <div key={entry.id} className="px-4 py-2.5 flex gap-3">
                        <span className="text-[10px] text-fg-faint font-mono shrink-0 pt-0.5 w-[60px]">
                          {formatTime(entry.timestamp)}
                        </span>
                        <div className="min-w-0 flex-1">
                          <span className="text-[12px] font-medium text-fg">{entry.agentName}</span>
                          <p className="text-[12px] text-fg-muted leading-relaxed truncate">
                            {entry.description}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function AgentCard({ agent, onClick }: { agent: Agent; onClick: () => void }) {
  const style = STATUS_STYLE[agent.status] ?? STATUS_STYLE.running;
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-4 border border-border bg-bg-elev rounded-[10px] px-5 py-4 hover:border-border-strong transition-colors cursor-pointer text-left group"
    >
      <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${style.dot} ${agent.inFlight ? "animate-pulse" : ""}`} />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium text-fg group-hover:text-brand transition-colors">{agent.name}</div>
        <div className="text-[11px] text-fg-muted font-mono truncate">{agent.role}</div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-[10px] text-fg-faint font-mono">
          every {formatSchedule(agent.scheduleSeconds)}
        </span>
        <span className={`text-[10px] font-mono font-medium ${agent.inFlight ? "text-brand" : "text-fg-faint"}`}>
          {agent.inFlight ? "thinking..." : style.label}
        </span>
      </div>
    </button>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-border rounded-[10px] bg-bg-elev px-4 py-3">
      <div className="text-[9px] text-fg-faint font-mono uppercase tracking-[1.5px]">{label}</div>
      <div className="text-[20px] font-semibold tracking-tight text-fg mt-0.5">{value}</div>
      {sub && <div className="text-[10px] text-fg-faint font-mono mt-0.5">{sub}</div>}
    </div>
  );
}
