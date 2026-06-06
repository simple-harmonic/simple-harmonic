// ---------------------------------------------------------------------------
// Task types — A2A task lifecycle
// ---------------------------------------------------------------------------
/** Valid task state transitions */
export const TASK_TRANSITIONS = {
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
export function isValidTransition(from, to) {
    return TASK_TRANSITIONS[from].includes(to);
}
//# sourceMappingURL=task.js.map