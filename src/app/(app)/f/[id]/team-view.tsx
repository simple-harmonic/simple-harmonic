"use client";

import { resolveCofounderName } from "@simple-harmonic/backend/lib/meta-agent/identity";
import { AgentMessagesView } from "@simple-harmonic/frontend/components/team/agent-messages-view";
import { AgentPovView } from "@simple-harmonic/frontend/components/team/agent-pov-view";
import { ApprovalQueue } from "@simple-harmonic/frontend/components/team/approval-queue";
import { TeamDashboard } from "@simple-harmonic/frontend/components/team/team-dashboard";
import { useTeam } from "@simple-harmonic/frontend/components/team/use-team";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";

interface TeamViewProps {
  teamId: string;
}

function TeamViewInner({ teamId }: TeamViewProps) {
  const searchParams = useSearchParams();
  const agentParam = searchParams.get("agent");

  const { team, agents, narration, loading, togglePause, updateAgent, updateTeam } =
    useTeam(teamId);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [userName, setUserName] = useState("You");

  // Load user display name from localStorage
  useEffect(() => {
    try {
      const raw = localStorage.getItem("sh:user-profile");
      if (raw) {
        const p = JSON.parse(raw);
        if (p.displayName) setUserName(p.displayName);
      }
    } catch {
      /* ignore */
    }
    const onStorage = (e: StorageEvent) => {
      if (e.key === "sh:user-profile") {
        try {
          const p = JSON.parse(e.newValue ?? "{}");
          if (p.displayName) setUserName(p.displayName);
        } catch {
          /* ignore */
        }
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const povId = agentParam ?? "team";

  const selectedAgent =
    povId !== "team" && povId !== "meta" && povId !== "user"
      ? agents.find((a) => a.id === povId)
      : null;

  const handleAgentUpdated = useCallback(
    (updated: {
      id: string;
      name: string;
      role: string;
      archetype: string;
      tools: string[];
      scheduleSeconds: number;
      initialPrompt: string;
      status: "running" | "paused" | "errored" | "awaiting_approval";
    }) => {
      updateAgent(updated);
    },
    [updateAgent],
  );

  if (loading || !team) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <span className="text-fg-faint text-sm font-mono">loading team...</span>
      </div>
    );
  }

  const runningCount = agents.filter((a) => a.status === "running").length;
  const totalTicks = team.tickCount;
  const tokensUp = totalTicks * 400;
  const tokensDown = totalTicks * 1200;
  const apiCost = (tokensUp * 3 + tokensDown * 15) / 1_000_000;

  return (
    <div className="flex flex-col h-full">
      {/* Content header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border bg-bg shrink-0">
        <div className="flex items-center gap-3">
          {editingName ? (
            <input
              ref={nameInputRef}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={async () => {
                const trimmed = draftName.trim();
                if (trimmed && trimmed !== team.name) {
                  const res = await fetch(`/api/team/${teamId}`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      name: trimmed,
                      metaAgentPrompt: team.metaAgentPrompt,
                      cofounderName: team.cofounderName,
                    }),
                  });
                  if (res.ok) {
                    updateTeam({ name: trimmed });
                  }
                }
                setEditingName(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                if (e.key === "Escape") {
                  setEditingName(false);
                }
              }}
              className="text-[13px] font-semibold bg-transparent border-b border-brand outline-none text-fg px-0 py-0 w-auto min-w-[80px]"
              style={{ width: `${Math.max(draftName.length, 6)}ch` }}
            />
          ) : (
            <h1 className="leading-tight">
              <button
                type="button"
                className="text-[13px] font-semibold cursor-pointer hover:text-brand transition-colors leading-tight"
                title="Click to rename"
                onClick={() => {
                  setDraftName(team.name);
                  setEditingName(true);
                  setTimeout(() => nameInputRef.current?.select(), 0);
                }}
              >
                {team.name}
              </button>
            </h1>
          )}
          <span className="inline-flex items-center gap-1.5 text-[11px] text-fg-faint font-mono">
            <span
              className={`w-1.5 h-1.5 rounded-full inline-block ${
                team.paused ? "bg-paused" : "bg-running"
              }`}
            />
            {team.paused ? `${agents.length} agents paused` : `${runningCount} running`} · tick{" "}
            {team.tickCount}
          </span>
          <span className="text-[11px] text-fg-faint font-mono">
            · {fmt(tokensUp)} in / {fmt(tokensDown)} out · ${apiCost.toFixed(2)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {team.paused && <span className="text-[11px] text-paused font-mono">paused by you</span>}
          <button
            type="button"
            onClick={togglePause}
            className="bg-brand text-white py-2 px-4 rounded text-[12px] font-mono font-medium uppercase tracking-wider cursor-pointer"
          >
            {team.paused ? "Resume" : "Pause Team"}
          </button>
        </div>
      </div>

      {povId === "meta" || povId === "user" ? (
        <div className="flex-1 min-h-0">
          <AgentMessagesView
            teamId={teamId}
            cofounderName={team.cofounderName}
            agents={agents.map((a) => ({ id: a.id, name: a.name, role: a.role, status: a.status }))}
            initialPovId={povId === "meta" ? "cofounder" : "user"}
            onClose={() => {
              window.history.pushState(null, "", `/f/${teamId}`);
              window.dispatchEvent(new PopStateEvent("popstate"));
            }}
          />
        </div>
      ) : povId === "team" ? (
        /* Team dashboard */
        <div className="flex-1 flex flex-col min-h-0">
          <ApprovalQueue
            teamId={teamId}
            agentNames={Object.fromEntries(agents.map((a) => [a.id, a.name]))}
          />
          <div className="flex-1 min-h-0">
            <TeamDashboard
              teamId={teamId}
              agents={agents.map((a) => ({
                id: a.id,
                name: a.name,
                role: a.role,
                status: a.status,
                inFlight: a.inFlight,
                scheduleSeconds: a.scheduleSeconds,
              }))}
              narration={narration}
              tickCount={team.tickCount}
              paused={team.paused}
              onAgentClick={(id) => {
                window.history.pushState(null, "", `/f/${teamId}?agent=${id}`);
                window.dispatchEvent(new PopStateEvent("popstate"));
              }}
            />
          </div>
        </div>
      ) : selectedAgent ? (
        /* Agent POV view */
        <div className="flex-1 min-h-0">
          <AgentPovView
            teamId={teamId}
            agent={{
              id: selectedAgent.id,
              name: selectedAgent.name,
              role: selectedAgent.role,
              archetype: selectedAgent.archetype,
              tools: selectedAgent.tools ?? [],
              scheduleSeconds: selectedAgent.scheduleSeconds,
              initialPrompt: selectedAgent.initialPrompt ?? "",
              status: selectedAgent.status,
              inFlight: selectedAgent.inFlight,
            }}
            teamAgents={agents.map((a) => ({ id: a.id, name: a.name, role: a.role, status: a.status }))}
            cofounderName={team.cofounderName}
            onUpdated={handleAgentUpdated}
          />
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-fg-faint text-sm font-mono">Agent not found</span>
        </div>
      )}

    </div>
  );
}

export function TeamView({ teamId }: TeamViewProps) {
  return (
    <Suspense>
      <TeamViewInner teamId={teamId} />
    </Suspense>
  );
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
