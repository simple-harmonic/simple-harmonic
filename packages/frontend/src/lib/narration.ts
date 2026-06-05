// Narration helpers shared by the live team UI (use-team, team-dashboard).
// Extracted from the former narration-sidebar component (now deleted); these
// are the only parts that were actually used.

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

function truncate(s: string | undefined, n: number): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n)}…` : s;
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
