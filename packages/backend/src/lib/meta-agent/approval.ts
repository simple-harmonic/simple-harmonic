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
  status: "running" | "paused" | "errored" | "awaiting_approval";
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
  | "awaiting_approval"
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
  if (agent.status === "awaiting_approval") {
    // The agent is parked mid-tick waiting on a human decision. It does NOT
    // run a fresh tick; the tick loop resumes it separately once its pending
    // approvals are resolved (see approveAgentTick callers + the resume path).
    return {
      allowed: false,
      reason: `${agent.name} is awaiting approval of a pending action.`,
      reasonCode: "awaiting_approval",
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

export interface ToolCallLike {
  toolName: string;
  arguments: Record<string, unknown>;
}

/**
 * Classifies whether a tool needs human approval before it runs. The app backs
 * this with the ToolRegistry's risk labels (risk === "destructive" -> true).
 * Kept as an injected predicate so this module stays pure — no import of the
 * registry, no I/O — and remains trivially testable.
 */
export type DestructiveClassifier = (toolName: string, rawArgs?: unknown) => boolean;

/**
 * Decide whether a single tool call may execute without human sign-off.
 *
 * `isDestructive` is the source of truth: safe tools are allowed; destructive
 * tools are held with reasonCode "destructive_unconfirmed", which the runner
 * turns into a suspension and the tick loop turns into a pending_approvals row.
 *
 * An unknown tool (one the classifier can't vouch for) is treated as
 * destructive — fail safe. Callers that don't pass a classifier get the
 * conservative default where everything is held, matching the pre-T2 stance
 * that only the internal tools were ever allowed.
 */
export function approveAgentAction(
  _team: TeamLike,
  _agent: AgentLike,
  call: ToolCallLike,
  isDestructive: DestructiveClassifier = () => true,
): ApprovalDecision {
  if (!isDestructive(call.toolName, call.arguments)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `Tool '${call.toolName}' requires approval before it runs.`,
    reasonCode: "destructive_unconfirmed",
  };
}
