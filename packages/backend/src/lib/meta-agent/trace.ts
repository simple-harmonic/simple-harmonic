// ---------------------------------------------------------------------------
// Play-by-play trace types.
//
// The runner emits one TraceStep for every observable step of a tick: tick
// boundaries, each LLM round (request + response), each tool call (start +
// finish), approval pauses, and the human decisions applied on resume. The
// sink is supplied by the caller (the tick route persists steps to the
// agent_trace_events table); the runner itself stays storage-agnostic.
//
// Contract: emitting is fire-and-forget. The runner wraps every sink call in
// try/catch, so a buggy sink can never break a tick — but sinks should still
// return fast (buffer internally, write asynchronously).
// ---------------------------------------------------------------------------

export type TraceEventType =
  /** A runner invocation began. data: { mode: "fresh" | "resume", round } */
  | "tick_started"
  /** An LLM round is about to call the model. data: { round, model, messageCount } */
  | "llm_request"
  /** The model answered. data: { round, thought, toolCalls: [{ toolCallId, tool }], finishReason, durationMs } */
  | "llm_response"
  /** A tool call is about to execute. data: { round, toolCallId, tool, args } */
  | "tool_started"
  /** A tool call settled. data: { round, toolCallId, tool, result | error, durationMs } */
  | "tool_finished"
  /** Destructive calls paused the tick for human sign-off. data: { round, pending: [{ toolCallId, tool, args }], deferredSafeCount } */
  | "approval_requested"
  /** A human decision was applied on resume. data: { toolCallId, tool, approved, note? } */
  | "decision_applied"
  /** The tick completed (not emitted when it suspends). data: { actionType, actionCount, durationMs, validation? } */
  | "tick_finished"
  /** The run threw or timed out. Emitted by the tick route, not the runner. data: { phase, error } */
  | "tick_failed";

export interface TraceStep {
  type: TraceEventType;
  data: Record<string, unknown>;
}

/** Sink receiving play-by-play steps. Must not block; must not throw. */
export type TraceSink = (step: TraceStep) => void;
