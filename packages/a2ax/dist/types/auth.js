// ---------------------------------------------------------------------------
// Auth types — A2A-compatible authentication
// ---------------------------------------------------------------------------
/** Default scopes for team-internal agents */
export const DEFAULT_SCOPES = [
    "message:send",
    "message:read",
    "task:create",
    "task:update",
    "broadcast:send",
    "group:join",
    "group:send",
    "card:read",
];
/** Check if a token has a required scope */
export function hasScope(token, scope) {
    return token.scopes.includes(scope) || token.scopes.includes("admin");
}
/** Generate a random bearer token */
export function generateToken() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
//# sourceMappingURL=auth.js.map