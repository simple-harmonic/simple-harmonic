// ---------------------------------------------------------------------------
// Task types — A2A task lifecycle
// ---------------------------------------------------------------------------

/** Task state enum (A2A-compatible) */
export type TaskState =
  | "submitted"
  | "accepted"
  | "working"
  | "input_required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";

/** A structured task (work request between agents) */
export interface Task {
  id: string;
  teamId: string;
  channelId: string;
  requestorId: string;
  assigneeId: string;
  title: string;
  description: string;
  state: TaskState;
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** Input for creating a new task */
export interface CreateTaskInput {
  teamId: string;
  requestorId: string;
  assigneeId: string;
  title: string;
  description: string;
  metadata?: Record<string, unknown>;
}

/** Input for updating a task */
export interface UpdateTaskInput {
  state?: TaskState;
  metadata?: Record<string, unknown>;
}

/** Valid task state transitions */
export const TASK_TRANSITIONS: Record<TaskState, TaskState[]> = {
  submitted: ["accepted", "rejected", "canceled"],
  accepted: ["working", "canceled"],
  working: ["input_required", "completed", "failed", "canceled"],
  input_required: ["working", "canceled"],
  completed: [],
  failed: [],
  canceled: [],
  rejected: [],
};

/** Check if a state transition is valid */
export function isValidTransition(from: TaskState, to: TaskState): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}
