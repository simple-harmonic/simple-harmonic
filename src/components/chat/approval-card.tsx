"use client";

import { useState } from "react";
import type { SpawnTeamAgent } from "@/lib/meta-agent";
import { DEFAULT_COFOUNDER_NAME } from "@/lib/meta-agent/identity";

function formatSchedule(seconds: number): string {
  if (seconds < 60) return `every ${seconds}s`;
  if (seconds < 3600) return `every ${Math.round(seconds / 60)}m`;
  return `every ${Math.round(seconds / 3600)}h`;
}

interface ApprovalCardProps {
  agents: SpawnTeamAgent[];
  teamName: string;
  cofounderName: string | null;
  onSpawn: (payload: {
    agents: SpawnTeamAgent[];
    teamName: string;
    cofounderName: string | null;
  }) => void;
  onKeepDiscussing: () => void;
  isSpawning?: boolean;
}

export function ApprovalCard({
  agents: initialAgents,
  teamName: initialTeamName,
  cofounderName: initialCofounderName,
  onSpawn,
  onKeepDiscussing,
  isSpawning = false,
}: ApprovalCardProps) {
  const [agents, setAgents] = useState(initialAgents);
  const [teamName, setTeamName] = useState(initialTeamName);
  const [cofounderName, setCofounderName] = useState(initialCofounderName ?? "");

  const updateAgent = (index: number, field: keyof SpawnTeamAgent, value: string | number) => {
    setAgents((prev) => prev.map((a, i) => (i === index ? { ...a, [field]: value } : a)));
  };

  return (
    <div className="border-[1.5px] border-brand bg-bg-elev rounded-[10px] px-[22px] py-5">
      <div className="flex justify-between items-start mb-4">
        <div>
          <div className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono">
            proposed team
          </div>
          <input
            value={teamName}
            onChange={(e) => setTeamName(e.target.value)}
            className="font-semibold text-[18px] mt-1 tracking-tight bg-transparent border-none outline-none text-fg w-full focus:bg-bg rounded px-1 -mx-1"
          />
          <div className="text-[12px] text-fg-muted mt-0.5">
            {agents.length} agents · supervised by{" "}
            <input
              value={cofounderName}
              onChange={(e) => setCofounderName(e.target.value)}
              placeholder={DEFAULT_COFOUNDER_NAME}
              className="bg-transparent border-none outline-none text-fg-muted focus:text-fg focus:bg-bg rounded px-1 -mx-1 max-w-[140px]"
            />
          </div>
        </div>
        <span className="text-xs text-fg-faint font-mono">click any field to edit</span>
      </div>

      <div className="flex flex-col gap-2">
        {agents.map((agent, i) => (
          <div
            key={agent.name}
            className="grid grid-cols-[200px_1fr_90px] gap-3.5 px-3 py-2.5 bg-bg border border-border rounded-md items-center"
          >
            <input
              value={agent.name}
              onChange={(e) => updateAgent(i, "name", e.target.value)}
              className="font-semibold text-sm bg-transparent border-none outline-none text-fg"
            />
            <input
              value={agent.role}
              onChange={(e) => updateAgent(i, "role", e.target.value)}
              className="text-[13px] text-fg-muted bg-transparent border-none outline-none"
            />
            <span className="text-xs text-fg-faint text-right font-mono">
              {formatSchedule(agent.schedule_seconds)}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-5 flex items-center gap-3.5">
        <button
          type="button"
          onClick={() =>
            onSpawn({
              agents,
              teamName: teamName.trim() || "New Team",
              cofounderName: cofounderName.trim() || null,
            })
          }
          disabled={isSpawning}
          className="bg-brand text-white py-[11px] px-[22px] rounded-md text-[15px] font-medium cursor-pointer disabled:opacity-60"
        >
          {isSpawning ? "Spawning..." : `Spawn ${agents.length} agents →`}
        </button>
        <button
          type="button"
          onClick={onKeepDiscussing}
          disabled={isSpawning}
          className="text-[13px] text-fg-muted underline cursor-pointer"
        >
          keep discussing
        </button>
        <span className="ml-auto text-[11px] text-fg-faint font-mono">~3 seconds to boot</span>
      </div>
    </div>
  );
}
