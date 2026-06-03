"use client";

export interface NarrationEntry {
  id: string;
  agentName: string;
  isMeta: boolean;
  actionType: string;
  description: string;
  timestamp: string;
  /** Tool output (file contents, stdout, API body) shown in a collapsible (T8). */
  detail?: string;
}

/**
 * Pull a UI-displayable output snippet from an action payload, if the action is
 * a tool that produced one (read_file, run_command, http_fetch, github_api all
 * store `output`). Returns undefined for actions with no inline output.
 */
export function extractDetail(payload: Record<string, unknown>): string | undefined {
  const output = payload?.output;
  if (typeof output === "string" && output.length > 0) return output;
  return undefined;
}

function formatTime(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
  if (d.toDateString() === now.toDateString()) return time;
  const date = d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  return `${date} ${time}`;
}

// Map an action type to its narration text. The runner emits a fixed set of
// types from tools.ts (message_sent, broadcast_sent, multi_action, agent_thought,
// noop) plus whatever the agent passes to `report_action`. Keep the unknown-fallback
// readable so custom action types are still informative.
export function describeAction(actionType: string, payload: Record<string, unknown>): string {
  switch (actionType) {
    // a2ax tool calls (runner)
    case "message_sent":
      return `messaged ${payload.to || "an agent"}: "${truncate(payload.content as string, 60)}"`;
    case "broadcast_sent":
      return `broadcast to ${payload.peerCount || 0} peers: "${truncate(payload.content as string, 50)}"`;
    case "multi_action": {
      const actions = (payload.actions as Array<{ type: string }> | undefined) ?? [];
      return `${actions.length} actions this tick`;
    }
    case "agent_thought":
      return truncate((payload.content as string) || "thinking", 80);
    case "noop":
      return "no action this tick";

    // v0.1 tools (T1) — the detail/output is shown in the collapsible below.
    case "file_read":
      return `read ${payload.path || "a file"} (${payload.bytes ?? 0} bytes)`;
    case "file_written":
      return `wrote ${payload.path || "a file"} (${payload.chars ?? 0} chars)`;
    case "command_run":
      return `ran ${payload.command || "a command"} ${((payload.args as string[]) ?? []).join(" ")}`.trim();
    case "http_fetched":
      return `fetched ${payload.url || "a URL"} → ${payload.status ?? "?"}`;
    case "github_api_called":
      return `GitHub ${payload.method || "GET"} ${payload.path || ""} → ${payload.status ?? "?"}`;
    case "awaiting_approval":
      return "awaiting your approval of a pending action";

    // Legacy / archetype-specific reports (kept for backward compat)
    case "draft_reply":
      return `drafted reply to '${payload.subject || "message"}' · awaiting your review`;
    case "draft_post":
      return `drafted ${payload.platform || "social"} post`;
    case "followup_queued":
      return `scheduled follow-up to ${payload.contact || "lead"}`;
    case "metrics_check":
      return `checked metrics · ${payload.status || "ok"}`;
    case "research_summary":
      return `${(payload.items as string[])?.length || 0} items from ${payload.source || "web"}`;

    // Team-level events (emitted client-side via togglePause)
    case "team_paused":
      return "team paused by user · holding state";
    case "team_resumed":
      return "team resumed by user";
    case "tick_started":
      return `tick started · ${payload.agentsDue || 0} agents due`;

    // Fallback: humanize the action_type token
    default: {
      const summary = payload.summary as string | undefined;
      if (summary) return summary;
      return actionType.replace(/_/g, " ");
    }
  }
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// Tiny icon glyph per action type. Mono unicode so it inherits text color.
function actionGlyph(actionType: string): string {
  if (actionType === "message_sent") return "→";
  if (actionType === "broadcast_sent") return "📣";
  if (actionType === "multi_action") return "⋯";
  if (actionType === "agent_thought") return "·";
  if (actionType === "noop") return "○";
  if (actionType === "tick_started") return "▸";
  if (actionType.startsWith("team_")) return "◆";
  if (actionType.startsWith("draft_")) return "✎";
  return "•";
}

interface NarrationSidebarProps {
  entries: NarrationEntry[];
  isLive: boolean;
}

export function NarrationSidebar({ entries, isLive }: NarrationSidebarProps) {
  return (
    <aside className="border-l border-border bg-bg-elev flex flex-col min-h-0">
      <div className="px-4 py-3 border-b border-border flex justify-between items-center shrink-0">
        <span className="text-[9px] text-fg-faint uppercase tracking-[1.5px] font-mono">
          narration
        </span>
        <span className="flex items-center gap-1.5 text-[9px] text-fg-faint font-mono">
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              isLive ? "bg-running animate-pulse" : "bg-paused"
            }`}
          />
          {isLive ? "live" : "paused"}
        </span>
      </div>
      <div className="px-4 py-3 overflow-y-auto flex-1 text-[13px] leading-snug">
        {entries.length === 0 && (
          <div className="text-fg-faint text-xs font-mono flex flex-col gap-1">
            <p>Waiting for first tick...</p>
            {!isLive && (
              <p className="text-[11px]">Resume the team to see live activity.</p>
            )}
          </div>
        )}
        {entries.map((entry, i) => (
          <div
            key={entry.id}
            className="mb-3 narration-entry"
            // Only fade newly arrived entries (top of list) to avoid replaying
            // the entire history animation on each poll.
            style={i < 3 ? { animation: "narration-fade-in 240ms ease-out" } : undefined}
          >
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono text-[10px] text-fg-faint shrink-0">
                {formatTime(entry.timestamp)}
              </span>
              <span className="text-fg-faint shrink-0" aria-hidden="true">
                {actionGlyph(entry.actionType)}
              </span>
            </div>
            <div className="mt-0.5">
              <span className={`font-semibold ${entry.isMeta ? "text-meta" : "text-fg"}`}>
                {entry.agentName}
              </span>{" "}
              <span className="text-fg-muted break-words">{entry.description}</span>
            </div>
            {entry.detail && (
              <details className="mt-1 rounded border border-border bg-bg-subtle">
                <summary className="cursor-pointer px-2 py-1 text-[10px] font-mono uppercase tracking-wide text-fg-faint">
                  output
                </summary>
                <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words px-2 pb-2 font-mono text-[11px] text-fg-muted">
                  {entry.detail}
                </pre>
              </details>
            )}
          </div>
        ))}
      </div>
      <style>{`
        @keyframes narration-fade-in {
          from {
            opacity: 0;
            transform: translateY(-4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
    </aside>
  );
}
