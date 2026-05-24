"use client";

import { useCallback, useState } from "react";
import { AgentDetailPanel } from "@/components/team/agent-detail-panel";
import { AgentGraph } from "@/components/team/agent-graph";
import { AgentMessagesView } from "@/components/team/agent-messages-view";
import { MetaAgentPanel } from "@/components/team/meta-agent-panel";
import { NarrationSidebar } from "@/components/team/narration-sidebar";
import { PausedBanner } from "@/components/team/paused-banner";
import { useTeam } from "@/components/team/use-team";
import { resolveCofounderName } from "@/lib/meta-agent/identity";
import { TopBar } from "@/components/top-bar";

interface TeamViewProps {
  teamId: string;
}

type PanelState =
  | { type: "none" }
  | { type: "agent"; agentId: string }
  | { type: "meta" };

type ViewMode = "graph" | "messages";

export function TeamView({ teamId }: TeamViewProps) {
  const { team, agents, narration, loading, togglePause, updateAgent, updateTeam } = useTeam(teamId);
  const [panel, setPanel] = useState<PanelState>({ type: "none" });
  const [viewMode, setViewMode] = useState<ViewMode>("graph");

  const selectedAgent = panel.type === "agent" ? agents.find((a) => a.id === panel.agentId) : null;

  const handleAgentUpdated = useCallback((updated: { id: string; name: string; role: string; archetype: string; tools: string[]; scheduleSeconds: number; initialPrompt: string; status: "running" | "paused" | "errored" }) => {
    updateAgent(updated);
  }, [updateAgent]);

  const handleMetaUpdated = useCallback((updates: { name: string; metaAgentPrompt: string | null; cofounderName: string | null }) => {
    updateTeam(updates);
  }, [updateTeam]);

  const closePanel = useCallback(() => setPanel({ type: "none" }), []);

  if (loading || !team) {
    return (
      <div className="flex flex-col h-full min-h-screen">
        <TopBar crumb="loading..." />
        <div className="flex-1 flex items-center justify-center">
          <span className="text-fg-faint text-sm font-mono">loading team...</span>
        </div>
      </div>
    );
  }

  const runningCount = agents.filter((a) => a.status === "running").length;
  const statusText = team.paused
    ? `${agents.length} agents paused · tick ${team.tickCount} was last`
    : `${runningCount} agents running · tick ${team.tickCount}`;

  return (
    <div className="flex flex-col h-full min-h-screen">
      {team.paused && <PausedBanner />}

      <TopBar
        crumb={team.name}
        right={
          <>
            {/* View mode tabs */}
            <div className="flex items-center border border-border rounded-md overflow-hidden mr-2">
              <button
                type="button"
                onClick={() => setViewMode("graph")}
                className={`px-3 py-1.5 text-[11px] font-mono cursor-pointer transition-colors ${
                  viewMode === "graph"
                    ? "bg-bg-elev text-fg"
                    : "text-fg-faint hover:text-fg-muted"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="5" r="3" />
                    <circle cx="5" cy="19" r="3" />
                    <circle cx="19" cy="19" r="3" />
                    <line x1="12" y1="8" x2="5" y2="16" />
                    <line x1="12" y1="8" x2="19" y2="16" />
                  </svg>
                  Graph
                </span>
              </button>
              <button
                type="button"
                onClick={() => setViewMode("messages")}
                className={`px-3 py-1.5 text-[11px] font-mono cursor-pointer transition-colors ${
                  viewMode === "messages"
                    ? "bg-bg-elev text-fg"
                    : "text-fg-faint hover:text-fg-muted"
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                  Messages
                </span>
              </button>
            </div>

            <span className="inline-flex items-center gap-1.5 text-xs text-fg-muted font-mono">
              <span
                className={`w-2 h-2 rounded-full inline-block ${
                  team.paused ? "bg-paused" : "bg-running"
                }`}
              />
              {statusText}
            </span>
            <button
              type="button"
              onClick={togglePause}
              className="bg-brand text-white py-[7px] px-3.5 rounded-[5px] text-[13px] font-medium cursor-pointer"
            >
              {team.paused ? "Resume" : "Pause Team"}
            </button>
          </>
        }
      />

      {viewMode === "graph" ? (
        <div className="flex-1 grid grid-cols-[1fr_380px] min-h-0">
          <main className="relative">
            <AgentGraph
              agents={agents.map((a) => ({
                id: a.id,
                name: a.name,
                role: a.role,
                status: a.status,
                inFlight: a.inFlight,
                scheduleSeconds: a.scheduleSeconds,
              }))}
              cofounderName={resolveCofounderName(team.cofounderName)}
              onAgentClick={(id) => setPanel({ type: "agent", agentId: id })}
              onMetaAgentClick={() => setPanel({ type: "meta" })}
            />
          </main>
          <NarrationSidebar entries={narration} isLive={!team.paused} />
        </div>
      ) : (
        <div className="flex-1 min-h-0">
          <AgentMessagesView
            teamId={teamId}
            cofounderName={team.cofounderName}
            agents={agents.map((a) => ({
              id: a.id,
              name: a.name,
              role: a.role,
              status: a.status,
            }))}
            onClose={() => setViewMode("graph")}
          />
        </div>
      )}

      {selectedAgent && (
        <AgentDetailPanel
          agent={{
            id: selectedAgent.id,
            name: selectedAgent.name,
            role: selectedAgent.role,
            archetype: selectedAgent.archetype,
            tools: selectedAgent.tools ?? [],
            scheduleSeconds: selectedAgent.scheduleSeconds,
            initialPrompt: selectedAgent.initialPrompt ?? "",
            status: selectedAgent.status,
          }}
          teamId={teamId}
          teamAgents={agents.map((a) => ({ id: a.id, name: a.name }))}
          onClose={closePanel}
          onUpdated={handleAgentUpdated}
        />
      )}

      {panel.type === "meta" && (
        <MetaAgentPanel
          teamId={teamId}
          teamName={team.name}
          metaAgentPrompt={team.metaAgentPrompt}
          cofounderName={team.cofounderName}
          onClose={closePanel}
          onUpdated={handleMetaUpdated}
        />
      )}
    </div>
  );
}
