"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface AgentRef {
  id: string;
  name: string;
  teamName: string;
}

interface Skill {
  name: string;
  description: string;
  category: string;
  risk: string;
  agentCount: number;
  agents: AgentRef[];
}

interface TeamAgent {
  id: string;
  name: string;
  role: string;
  tools: string[];
  teamId: string;
  teamName: string;
}

export default function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [allAgents, setAllAgents] = useState<TeamAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingAgent, setEditingAgent] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => {
    fetch("/api/settings/skills")
      .then((r) => r.json())
      .then(async (skillData) => {
        setSkills(skillData.skills ?? []);
        try {
          const teamsRes = await fetch("/api/teams");
          const teams = await teamsRes.json();
          if (!Array.isArray(teams)) { setLoading(false); return; }
          const agentList: TeamAgent[] = [];
          for (const team of teams) {
            const res = await fetch(`/api/team/${team.id}`);
            const data = await res.json();
            if (data.agents) {
              for (const a of data.agents) {
                agentList.push({
                  id: a.id,
                  name: a.name,
                  role: a.role,
                  tools: a.tools ?? [],
                  teamId: team.id,
                  teamName: team.name,
                });
              }
            }
          }
          setAllAgents(agentList);
        } catch {
          // DB unavailable: show skills without agent assignments
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const toggleTool = useCallback(
    async (agentId: string, toolName: string, enabled: boolean) => {
      const agent = allAgents.find((a) => a.id === agentId);
      if (!agent) return;
      const next = enabled
        ? [...agent.tools, toolName]
        : agent.tools.filter((t) => t !== toolName);

      setSaving(true);
      try {
        const res = await fetch("/api/settings/skills", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agentId, tools: next }),
        });
        if (res.ok) {
          setAllAgents((prev) =>
            prev.map((a) => (a.id === agentId ? { ...a, tools: next } : a)),
          );
          reload();
        }
      } finally {
        setSaving(false);
      }
    },
    [allAgents, reload],
  );

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <span className="text-fg-faint text-sm font-mono">loading...</span>
      </div>
    );
  }

  const categories = [...new Set(skills.map((s) => s.category))];

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[720px] mx-auto px-6 py-10">
        <div className="flex items-center gap-2 mb-1">
          <Link
            href="/settings"
            className="text-fg-faint hover:text-fg-muted text-[12px] font-mono transition-colors"
          >
            Settings
          </Link>
          <span className="text-fg-faint text-[12px] font-mono">/</span>
          <span className="text-fg text-[12px] font-mono">Skills</span>
        </div>
        <h1 className="text-lg font-semibold tracking-tight mb-2">Skills</h1>
        <p className="text-[13px] text-fg-muted mb-8">
          Tools available to agents. Assign or remove skills per agent to control what they can do.
        </p>

        {categories.map((cat) => (
          <section key={cat} className="mb-8">
            <h2 className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono mb-3">
              {cat}
            </h2>
            <div className="flex flex-col gap-3">
              {skills
                .filter((s) => s.category === cat)
                .map((skill) => (
                  <SkillCard
                    key={skill.name}
                    skill={skill}
                    allAgents={allAgents}
                    editingAgent={editingAgent}
                    onEditAgent={setEditingAgent}
                    onToggle={toggleTool}
                    saving={saving}
                  />
                ))}
            </div>
          </section>
        ))}

        {allAgents.length > 0 && (
          <section className="mt-12">
            <h2 className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono mb-3">
              Per-agent assignments
            </h2>
            <div className="flex flex-col gap-3">
              {allAgents.map((agent) => (
                <AgentSkillRow
                  key={agent.id}
                  agent={agent}
                  skills={skills}
                  onToggle={toggleTool}
                  saving={saving}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function SkillCard({
  skill,
  allAgents,
  editingAgent,
  onEditAgent,
  onToggle,
  saving,
}: {
  skill: Skill;
  allAgents: TeamAgent[];
  editingAgent: string | null;
  onEditAgent: (id: string | null) => void;
  onToggle: (agentId: string, toolName: string, enabled: boolean) => void;
  saving: boolean;
}) {
  return (
    <div className="border border-border bg-bg-elev rounded-[10px] px-5 py-4">
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-fg font-mono">{skill.name}</span>
            <span
              className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                skill.risk === "destructive"
                  ? "bg-error/15 text-error"
                  : "bg-running/15 text-running"
              }`}
            >
              {skill.risk}
            </span>
          </div>
          <p className="text-[12px] text-fg-muted mt-1 leading-relaxed">
            {skill.description}
          </p>
        </div>
        <span className="text-[11px] text-fg-faint font-mono shrink-0 ml-3">
          {skill.agentCount} agent{skill.agentCount !== 1 ? "s" : ""}
        </span>
      </div>
      {skill.agents.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {skill.agents.map((a) => (
            <span
              key={a.id}
              className="text-[11px] font-mono text-fg-muted bg-bg px-2 py-0.5 rounded"
            >
              {a.name}
              <span className="text-fg-faint ml-1">({a.teamName})</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentSkillRow({
  agent,
  skills,
  onToggle,
  saving,
}: {
  agent: TeamAgent;
  skills: Skill[];
  onToggle: (agentId: string, toolName: string, enabled: boolean) => void;
  saving: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="border border-border bg-bg-elev rounded-[10px] px-5 py-4">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between cursor-pointer"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-[13px] font-medium text-fg">{agent.name}</span>
          <span className="text-[11px] text-fg-faint font-mono">{agent.teamName}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-fg-faint font-mono">
            {agent.tools.length} skill{agent.tools.length !== 1 ? "s" : ""}
          </span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            className={`text-fg-faint transition-transform ${expanded ? "rotate-180" : ""}`}
          >
            <path
              d="M3 4.5L6 7.5L9 4.5"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      </button>
      {expanded && (
        <div className="mt-3 pt-3 border-t border-border grid grid-cols-2 gap-2">
          {skills.map((skill) => {
            const enabled = agent.tools.includes(skill.name);
            return (
              <label
                key={skill.name}
                className="flex items-center gap-2 cursor-pointer py-1"
              >
                <input
                  type="checkbox"
                  checked={enabled}
                  disabled={saving}
                  onChange={() => onToggle(agent.id, skill.name, !enabled)}
                  className="accent-brand w-3.5 h-3.5"
                />
                <span className="text-[12px] font-mono text-fg-muted">{skill.name}</span>
                {skill.risk === "destructive" && (
                  <span className="text-[9px] font-mono text-error">!</span>
                )}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}
