"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NarrationEntry } from "./narration-sidebar";
import { describeAction, extractDetail } from "./narration-sidebar";

interface TeamAgent {
  id: string;
  name: string;
  role: string;
  status: "running" | "paused" | "errored" | "awaiting_approval";
  inFlight: boolean;
  scheduleSeconds: number;
  archetype: string;
  tools: string[];
  initialPrompt: string;
  teamId: string;
}

interface TeamData {
  id: string;
  name: string;
  paused: boolean;
  tickCount: number;
  metaAgentPrompt: string | null;
  cofounderName: string | null;
}

interface ChildTeam {
  id: string;
  name: string;
  parentTeamId: string | null;
  paused: boolean;
}

interface UseTeamReturn {
  team: TeamData | null;
  agents: TeamAgent[];
  childTeams: ChildTeam[];
  childAgents: TeamAgent[];
  narration: NarrationEntry[];
  loading: boolean;
  togglePause: () => Promise<void>;
  updateAgent: (updated: Partial<TeamAgent> & { id: string }) => void;
  updateTeam: (updated: Partial<TeamData>) => void;
}

export function useTeam(teamId: string): UseTeamReturn {
  const [team, setTeam] = useState<TeamData | null>(null);
  const [agents, setAgents] = useState<TeamAgent[]>([]);
  const [childTeams, setChildTeams] = useState<ChildTeam[]>([]);
  const [childAgents, setChildAgents] = useState<TeamAgent[]>([]);
  const [narration, setNarration] = useState<NarrationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const agentsRef = useRef<TeamAgent[]>([]);

  useEffect(() => {
    fetch(`/api/team/${teamId}`)
      .then((res) => res.json())
      .then((data) => {
        setTeam(data.team);
        setAgents(data.agents);
        setChildTeams(data.childTeams ?? []);
        setChildAgents(data.childAgents ?? []);
        agentsRef.current = data.agents;
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [teamId]);

  const isPaused = team?.paused ?? true;
  useEffect(() => {
    if (isPaused) return;

    // Fire a tick on each poll so agents actually run in dev mode.
    // In production, Vercel cron hits /api/tick independently.
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/team/${teamId}`);
        const data = await res.json();
        setTeam(data.team);
        setAgents(data.agents);
        agentsRef.current = data.agents;

        const newEntries: NarrationEntry[] = data.agents
          .filter((a: TeamAgent) => a.inFlight)
          .map((a: TeamAgent) => ({
            id: `${a.id}-${Date.now()}`,
            agentName: a.name,
            isMeta: false,
            actionType: "thinking",
            description: "processing...",
            timestamp: new Date().toISOString(),
          }));

        if (newEntries.length > 0) {
          setNarration((prev) => [...newEntries, ...prev].slice(0, 100));
        }
      } catch {
        // poll failure, will retry
      }
    }, 10_000);

    return () => clearInterval(interval);
  }, [teamId, isPaused]);

  // Heartbeat: keep team alive while user has the page open
  useEffect(() => {
    fetch(`/api/team/${teamId}/heartbeat`, { method: "POST" }).catch(() => {});
    const heartbeat = setInterval(() => {
      fetch(`/api/team/${teamId}/heartbeat`, { method: "POST" }).catch(() => {});
    }, 30_000);
    return () => clearInterval(heartbeat);
  }, [teamId]);

  const teamLoaded = !!team;
  useEffect(() => {
    if (!teamLoaded) return;

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

    fetch(`/api/team/${teamId}/narration`)
      .then(async (response) => {
        reader = response.body?.getReader();
        if (!reader) return;

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === "history" || data.type === "update") {
                const entries: NarrationEntry[] = data.entries.map(
                  (e: {
                    id: string;
                    agentId: string;
                    actionType: string;
                    payload: Record<string, unknown>;
                    executedAt: string;
                  }) => ({
                    id: e.id,
                    agentName: agentsRef.current.find((a) => a.id === e.agentId)?.name ?? "agent",
                    isMeta: e.actionType.startsWith("meta_"),
                    actionType: e.actionType,
                    description: describeAction(e.actionType, e.payload),
                    timestamp: e.executedAt,
                    detail: extractDetail(e.payload),
                  }),
                );
                if (data.type === "history") {
                  setNarration(entries);
                } else {
                  setNarration((prev) => {
                    const ids = new Set(prev.map((p) => p.id));
                    const newOnes = entries.filter((e: NarrationEntry) => !ids.has(e.id));
                    return [...newOnes, ...prev].slice(0, 100);
                  });
                }
              }
            } catch {
              // skip malformed SSE
            }
          }
        }
      })
      .catch(() => {});

    return () => {
      reader?.cancel();
    };
  }, [teamId, teamLoaded]);

  const updateAgent = useCallback((updated: Partial<TeamAgent> & { id: string }) => {
    setAgents((prev) => prev.map((a) => (a.id === updated.id ? { ...a, ...updated } : a)));
  }, []);

  const updateTeam = useCallback((updated: Partial<TeamData>) => {
    setTeam((prev) => (prev ? { ...prev, ...updated } : prev));
  }, []);

  const togglePause = useCallback(async () => {
    if (!team) return;
    const res = await fetch(`/api/team/${teamId}/pause`, { method: "POST" });
    const { paused } = await res.json();
    setTeam((prev) => (prev ? { ...prev, paused } : prev));

    setNarration((prev) => [
      {
        id: crypto.randomUUID(),
        agentName: "meta-agent",
        isMeta: true,
        actionType: paused ? "team_paused" : "team_resumed",
        description: paused ? "team paused by user · holding state" : "team resumed by user",
        timestamp: new Date().toISOString(),
      },
      ...prev,
    ]);
  }, [team, teamId]);

  return { team, agents, childTeams, childAgents, narration, loading, togglePause, updateAgent, updateTeam };
}
