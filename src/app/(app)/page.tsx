"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface Team {
  id: string;
  name: string;
  paused: boolean;
  tickCount: number;
  createdAt: string;
  parentTeamId: string | null;
}

interface TeamNode {
  team: Team;
  children: TeamNode[];
}

function buildTeamTree(teams: Team[]): TeamNode[] {
  const byParent = new Map<string | null, Team[]>();
  for (const t of teams) {
    const key = t.parentTeamId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(t);
    byParent.set(key, list);
  }
  function build(parentId: string | null): TeamNode[] {
    return (byParent.get(parentId) ?? []).map((t) => ({
      team: t,
      children: build(t.id),
    }));
  }
  return build(null);
}

export default function OverviewPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/teams")
      .then((res) => res.json())
      .then((data) => {
        setTeams(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const totalTicks = teams.reduce((sum, t) => sum + t.tickCount, 0);
  const runningTeams = teams.filter((t) => !t.paused).length;
  const tokensUp = totalTicks * 400;
  const tokensDown = totalTicks * 1200;
  const apiCost = (tokensUp * 3 + tokensDown * 15) / 1_000_000;

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <span className="text-fg-faint text-sm font-mono">loading...</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-8 py-10">
        <h1 className="text-[14px] font-semibold font-mono uppercase tracking-[1px] mb-6">Overview</h1>

        <div className="grid grid-cols-4 gap-3 mb-4">
          <StatCard label="Teams" value={String(teams.length)} sub={`${runningTeams} running`} />
          <StatCard label="Total Ticks" value={fmt(totalTicks)} />
          <StatCard label="Tokens In" value={fmt(tokensUp)} sub="estimated" />
          <StatCard label="Tokens Out" value={fmt(tokensDown)} sub="estimated" />
        </div>

        <div className="grid grid-cols-3 gap-3 mb-10">
          <StatCard label="API Cost" value={`$${apiCost.toFixed(2)}`} sub="estimated from usage" />
          <StatCard label="Agent Spending" value="$0.00" sub="no integrations yet" />
          <StatCard label="Income Generated" value="$0.00" sub="no integrations yet" />
        </div>

        <h2 className="text-[9px] text-brand font-semibold tracking-[1.5px] uppercase font-mono mb-3">
          Teams
        </h2>

        {teams.length === 0 ? (
          <div className="border border-border rounded p-8 text-center">
            <p className="text-sm text-fg-faint mb-4">No teams yet.</p>
            <Link href="/new" className="text-sm font-medium text-brand hover:underline">
              Create your first team
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {buildTeamTree(teams).map((node) => (
              <OverviewTeamNode key={node.team.id} node={node} depth={0} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function OverviewTeamNode({ node, depth }: { node: TeamNode; depth: number }) {
  const t = node.team;
  return (
    <>
      <Link
        href={`/f/${t.id}`}
        className="flex items-center justify-between border border-border rounded px-4 py-3 hover:border-border-strong transition-colors group"
        style={{ marginLeft: depth * 24 }}
      >
        <div className="flex items-center gap-3">
          <span className={`w-2 h-2 rounded-full ${t.paused ? "bg-paused" : "bg-running"}`} />
          <span className="text-[13px] font-medium group-hover:text-fg transition-colors">
            {t.name}
          </span>
          {depth > 0 && (
            <span className="text-[10px] text-fg-faint font-mono">sub-team</span>
          )}
        </div>
        <div className="flex items-center gap-4">
          <span className="text-[11px] text-fg-faint font-mono">{t.tickCount} ticks</span>
          <span className={`text-[11px] font-mono ${t.paused ? "text-fg-faint" : "text-running"}`}>
            {t.paused ? "paused" : "running"}
          </span>
        </div>
      </Link>
      {node.children.map((child) => (
        <OverviewTeamNode key={child.team.id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="border border-border bg-bg-elev rounded px-4 py-3">
      <div className="text-[9px] text-fg-faint font-mono uppercase tracking-[1.5px] mb-1">{label}</div>
      <div className="text-[20px] font-semibold tracking-tight text-fg">{value}</div>
      {sub && <div className="text-[11px] text-fg-faint font-mono mt-0.5">{sub}</div>}
    </div>
  );
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}
