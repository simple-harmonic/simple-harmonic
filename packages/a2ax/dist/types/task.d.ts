/** Task state enum (A2A-compatible) */
export type TaskState = "submitted" | "accepted" | "working" | "input_required" | "completed" | "failed" | "canceled" | "rejected";
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
export declare const TASK_TRANSITIONS: Record<TaskState, TaskState[]>;
/** Check if a state transition is valid */
export declare function isValidTransition(from: TaskState, to: TaskState): boolean;
//# sourceMappingURL=task.d.ts.map