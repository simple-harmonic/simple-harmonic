// ---------------------------------------------------------------------------
// Approval gate
//
// Per CLAUDE.md decisions, every tick of every agent passes through the
// meta-agent's approval before running. This is the seam where pause, edit,
// disable, and (in v0.1) per-action destructive-action approval all meet.
//
// In v0.0 the tools are all internal (a2ax messaging + report_action), so
// nothing is truly destructive. The gate enforces:
//   - team not paused
//   - agent status === "running"
//   - agent not already in_flight (no overlapping ticks)
//
// In v0.1, when external integrations land, plug per-action approval into
// `approveAgentAction` below. Keep this module pure (no DB, no SDK) so it
// stays trivially testable.
// ---------------------------------------------------------------------------

export interface AgentLike {
  id: string;
  name: string;
  status: "running" | "paused" | "errored";
  inFlight: boolean;
  nextRunAt: Date | null;
}

export interface TeamLike {
  id: string;
  paused: boolean;
}

export type ApprovalDecision =
  | { allowed: true }
  | { allowed: false; reason: string; reasonCode: ApprovalReasonCode };

export type ApprovalReasonCode =
  | "team_paused"
  | "agent_paused"
  | "agent_errored"
  | "agent_in_flight"
  | "not_due"
  | "destructive_unconfirmed";

const NOW_FN = () => new Date();

/**
 * Decide whether an agent should run on this tick.
 *
 * Pure function: pass in team + agent state plus an optional clock, get back
 * a decision. The tick loop calls this; tests can call it directly.
 */
export function approveAgentTick(
  team: TeamLike,
  agent: AgentLike,
  now: Date = NOW_FN(),
): ApprovalDecision {
  if (team.paused) {
    return { allowed: false, reason: "Team is paused.", reasonCode: "team_paused" };
  }
  if (agent.status === "paused") {
    return {
      allowed: false,
      reason: `${agent.name} is paused.`,
      reasonCode: "agent_paused",
    };
  }
  if (agent.status === "errored") {
    return {
      allowed: false,
      reason: `${agent.name} is errored; resolve before resuming.`,
      reasonCode: "agent_errored",
    };
  }
  if (agent.inFlight) {
    return {
      allowed: false,
      reason: `${agent.name} is mid-tick; waiting for it to finish.`,
      reasonCode: "agent_in_flight",
    };
  }
  if (!agent.nextRunAt || agent.nextRunAt > now) {
    return {
      allowed: false,
      reason: `${agent.name} not due yet.`,
      reasonCode: "not_due",
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Per-action approval (v0.1 seam)
//
// When the agent runner is about to execute a tool call that would cause an
// external side effect (send email, post to social, write to a third-party
// DB), it asks this function. Today there are no such tools, so this returns
// allow for everything. The hook is here so v0.1 can wire in:
//   - allowlist / denylist of tool names per agent
//   - human approval queue (pause until the cofounder or user approves)
//   - dry-run preview before commit
// ---------------------------------------------------------------------------

// Tools considered safe (internal-only, no external side effects).
const INTERNAL_TOOLS = new Set(["send_message", "broadcast", "report_action"]);

export interface ToolCallLike {
  toolName: string;
  arguments: Record<string, unknown>;
}

export function approveAgentAction(
  _team: TeamLike,
  _agent: AgentLike,
  call: ToolCallLike,
): ApprovalDecision {
  if (INTERNAL_TOOLS.has(call.toolName)) {
    return { allowed: true };
  }
  // Unknown / external tool: require explicit confirmation. v0.0 never hits
  // this branch because the agent tool set is internal-only. Wired here so
  // v0.1 can replace the body with a human-approval queue.
  return {
    allowed: false,
    reason: `Tool '${call.toolName}' is not on the v0.0 allowlist.`,
    reasonCode: "destructive_unconfirmed",
  };
}
