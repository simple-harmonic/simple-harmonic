"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";

interface Team {
  id: string;
  name: string;
  paused: boolean;
  parentTeamId: string | null;
}

interface Agent {
  id: string;
  name: string;
  role: string;
  status: "running" | "paused" | "errored" | "awaiting_approval";
}

function SidebarInner() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamAgents, setTeamAgents] = useState<Record<string, Agent[]>>({});
  const [teamCofounderNames, setTeamCofounderNames] = useState<Record<string, string>>({});
  const [collapsed, setCollapsed] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);
  const [displayName, setDisplayName] = useState("You");
  const [userRole, setUserRole] = useState("Founder");

  useEffect(() => {
    const load = () => {
      try {
        const raw = localStorage.getItem("sh:user-profile");
        if (raw) {
          const p = JSON.parse(raw);
          if (p.displayName) setDisplayName(p.displayName);
          if (p.role) setUserRole(p.role);
        }
      } catch { /* ignore */ }
    };
    load();
    const onStorage = (e: StorageEvent) => {
      if (e.key === "sh:user-profile") load();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!userMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [userMenuOpen]);

  const teamMatch = pathname.match(/^\/f\/([^/]+)/);
  const activeTeamId = teamMatch?.[1] ?? null;
  const activeAgentId = searchParams.get("agent");

  useEffect(() => {
    fetch("/api/teams")
      .then((res) => res.json())
      .then((data) => setTeams(data))
      .catch(() => {});
  }, []);

  // Load agents for all teams so any node can expand without a fetch.
  // At expected scale (<20 teams) this is a few small requests on mount.
  useEffect(() => {
    if (teams.length === 0) return;
    for (const t of teams) {
      if (teamAgents[t.id]) continue;
      fetch(`/api/team/${t.id}`)
        .then((res) => res.json())
        .then((data) => {
          if (data.agents) {
            setTeamAgents((prev) => ({ ...prev, [t.id]: data.agents }));
          }
          if (data.team?.cofounderName) {
            setTeamCofounderNames((prev) => ({ ...prev, [t.id]: data.team.cofounderName }));
          }
        })
        .catch(() => {});
    }
  }, [teams, teamAgents]);

  if (collapsed) {
    return (
      <aside className="w-12 border-r border-border bg-bg flex flex-col items-center py-3 shrink-0">
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="text-fg-faint hover:text-brand transition-colors cursor-pointer p-1"
          title="Expand sidebar"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M6 3L11 8L6 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </aside>
    );
  }

  const agents = activeTeamId ? (teamAgents[activeTeamId] ?? []) : [];

  return (
    <aside className="w-[240px] border-r border-border bg-bg flex flex-col shrink-0 h-full">
      <div className="px-4 py-3 flex items-center justify-between">
        <Link href="/" className="text-[10px] uppercase tracking-[1.5px] font-medium text-fg hover:text-brand transition-colors font-mono">
          Simple Harmonic
        </Link>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          className="text-fg-faint hover:text-fg-muted transition-colors cursor-pointer p-0.5"
          title="Collapse sidebar"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M10 3L5 8L10 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto px-2 py-1 bg-bg-elev">
        <SidebarLink href="/" active={pathname === "/"} label="Overview" />

        <div className="mt-4 mb-1.5 flex items-center justify-between px-2">
          <span className="text-[9px] text-fg-faint font-mono uppercase tracking-[1.5px]">Teams</span>
          <Link
            href="/new"
            className="group relative w-5 h-5 flex items-center justify-center rounded-none text-fg-faint hover:text-brand hover:bg-brand-soft/50 transition-colors"
            title="New Team"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 1v10M1 6h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            </svg>
            <span className="pointer-events-none absolute right-full mr-2 hidden group-hover:block whitespace-nowrap rounded-none bg-fg text-bg text-[11px] font-mono px-2 py-0.5">
              New Team
            </span>
          </Link>
        </div>

        {teams.length === 0 ? (
          <div className="px-2 py-1.5 text-[12px] text-fg-faint">No teams yet</div>
        ) : (
          buildTeamTree(teams).map((node) => (
            <TeamTreeNode
              key={node.id}
              node={node}
              depth={0}
              activeTeamId={activeTeamId}
              activeAgentId={activeAgentId}
              teamAgents={teamAgents}
              teamCofounderNames={teamCofounderNames}
              displayName={displayName}
            />
          ))
        )}
      </nav>

      <div className="border-t border-border px-3 py-2.5 relative" ref={userMenuRef}>
        {userMenuOpen && (
          <div className="absolute bottom-full left-2 right-2 mb-1.5 bg-bg border border-border rounded-none shadow-lg overflow-hidden z-50">
            <Link
              href="/profile"
              onClick={() => setUserMenuOpen(false)}
              className="flex items-center gap-2.5 px-3 py-2 text-[12px] text-fg-muted hover:bg-bg-elev hover:text-fg transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                <circle cx="12" cy="7" r="4" />
              </svg>
              Profile
            </Link>
            <Link
              href="/settings"
              onClick={() => setUserMenuOpen(false)}
              className="flex items-center gap-2.5 px-3 py-2 text-[12px] text-fg-muted hover:bg-bg-elev hover:text-fg transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              Settings
            </Link>
            <div className="border-t border-border" />
            <button
              type="button"
              onClick={() => {
                setUserMenuOpen(false);
                window.location.href = "/login";
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-[12px] text-fg-muted hover:bg-bg-elev hover:text-fg transition-colors cursor-pointer"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
              Log out
            </button>
          </div>
        )}
        <button
          type="button"
          onClick={() => setUserMenuOpen((v) => !v)}
          className="w-full flex items-center gap-2.5 rounded-none px-1 py-1 hover:bg-bg-elev transition-colors cursor-pointer"
        >
          <div className="w-7 h-7 rounded-full bg-brand/15 text-brand flex items-center justify-center text-[11px] font-semibold shrink-0">
            {displayName[0].toUpperCase()}
          </div>
          <div className="flex-1 min-w-0 text-left">
            <div className="text-[12px] text-fg font-medium truncate">{displayName}</div>
            <div className="text-[10px] text-fg-faint font-mono truncate">{userRole}</div>
          </div>
        </button>
      </div>
    </aside>
  );
}

export function Sidebar() {
  return (
    <Suspense>
      <SidebarInner />
    </Suspense>
  );
}

interface TeamNode {
  id: string;
  name: string;
  paused: boolean;
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
      id: t.id,
      name: t.name,
      paused: t.paused,
      children: build(t.id),
    }));
  }
  return build(null);
}

function isInSubTree(node: TeamNode, targetId: string): boolean {
  if (node.id === targetId) return true;
  return node.children.some((c) => isInSubTree(c, targetId));
}

function TeamTreeNode({
  node,
  depth,
  activeTeamId,
  activeAgentId,
  teamAgents,
  teamCofounderNames,
  displayName,
}: {
  node: TeamNode;
  depth: number;
  activeTeamId: string | null;
  activeAgentId: string | null;
  teamAgents: Record<string, Agent[]>;
  teamCofounderNames: Record<string, string>;
  displayName: string;
}) {
  const isActive = activeTeamId === node.id && !activeAgentId;
  const isInActivePath = activeTeamId ? isInSubTree(node, activeTeamId) : false;
  const agents = teamAgents[node.id] ?? [];
  const hasChildren = node.children.length > 0;
  const hasContent = agents.length > 0 || hasChildren;

  // Auto-expand if active or in the active path; user can toggle
  const [expanded, setExpanded] = useState(isActive || isInActivePath);

  // Sync expansion when navigation changes
  useEffect(() => {
    if (isActive || isInActivePath) setExpanded(true);
  }, [isActive, isInActivePath]);

  const chevron = hasContent ? (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setExpanded((v) => !v); }}
      className="w-4 h-4 flex items-center justify-center shrink-0 text-fg-faint hover:text-fg-muted transition-colors cursor-pointer"
    >
      <svg
        width="10"
        height="10"
        viewBox="0 0 10 10"
        fill="none"
        className={`transition-transform ${expanded ? "rotate-90" : ""}`}
      >
        <path d="M3 1.5L7 5L3 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  ) : (
    <span className="w-4 h-4 shrink-0" />
  );

  return (
    <div style={{ paddingLeft: depth > 0 ? 4 : 0 }}>
      <div className={`flex items-center gap-0.5 ${depth > 0 ? "rounded bg-bg-elev/60" : ""}`}>
        {chevron}
        <div className="flex-1 min-w-0">
          <SidebarLink
            href={`/f/${node.id}`}
            active={isActive}
            label={node.name}
            indicator={
              depth > 0 ? (
                // Sub-team: a "team" (group of agents) icon, tinted by run state.
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke={node.paused ? "var(--color-paused)" : "var(--color-running)"}
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  className="shrink-0"
                >
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              ) : (
                <span className={`w-1.5 h-1.5 rounded-full inline-block shrink-0 ${node.paused ? "bg-paused" : "bg-running"}`} />
              )
            }
          />
        </div>
      </div>
      {expanded && (
        <div className="ml-[9px] border-l border-border pl-2">
          {/* People — pinned to root teams. "You" (the founder) and Harmon
              (the cofounder, auto-spawned only on root teams) belong to the
              top-level team and must not relocate into a sub-team when it's
              expanded or active. Sub-team leads are ordinary `agents` entries. */}
          {depth === 0 && (
            <>
              <SidebarLink
                href={`/f/${node.id}?agent=user`}
                active={activeAgentId === "user"}
                label={displayName}
                small
                indicator={
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-user, #3b82f6)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                  </svg>
                }
              />
              <SidebarLink
                href={`/f/${node.id}?agent=meta`}
                active={activeAgentId === "meta"}
                label={teamCofounderNames[node.id] || "Harmon"}
                small
                indicator={
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-meta, #ff832b)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
                    {/* sparkle — marks Harmon as the AI cofounder */}
                    <path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3z" />
                  </svg>
                }
              />
            </>
          )}
          {/* Agents */}
          {agents.length > 0 && (
            <>
              {agents.map((agent) => (
                <SidebarLink
                  key={agent.id}
                  href={`/f/${node.id}?agent=${agent.id}`}
                  active={activeAgentId === agent.id}
                  label={agent.name}
                  small
                  indicator={
                    <span className={`w-1.5 h-1.5 rounded-full inline-block shrink-0 ${
                      agent.status === "running" ? "bg-running" :
                      agent.status === "errored" ? "bg-error" :
                      agent.status === "awaiting_approval" ? "bg-brand" : "bg-paused"
                    }`} />
                  }
                />
              ))}
            </>
          )}
          {/* Sub-teams */}
          {hasChildren && (
            <>
              {node.children.map((child) => (
                <TeamTreeNode
                  key={child.id}
                  node={child}
                  depth={depth + 1}
                  activeTeamId={activeTeamId}
                  activeAgentId={activeAgentId}
                  teamAgents={teamAgents}
                  teamCofounderNames={teamCofounderNames}
                  displayName={displayName}
                />
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function SidebarLink({
  href,
  active,
  label,
  indicator,
  accent,
  small,
}: {
  href: string;
  active: boolean;
  label: string;
  indicator?: React.ReactNode;
  accent?: boolean;
  small?: boolean;
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-2 px-2 py-[5px] leading-[18px] rounded-none transition-colors ${
        small ? "text-[12px]" : "text-[13px]"
      } ${
        active
          ? "border-l-2 border-brand bg-brand-soft/30 text-fg font-medium"
          : accent
            ? "border-l-2 border-transparent text-brand hover:bg-bg hover:border-brand/50"
            : "border-l-2 border-transparent text-fg-muted hover:bg-bg hover:text-fg"
      }`}
    >
      {indicator}
      <span className="truncate">{label}</span>
    </Link>
  );
}
