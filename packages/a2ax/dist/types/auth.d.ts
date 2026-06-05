/** A bearer token issued to an agent at spawn time */
export interface AgentToken {
    agentId: string;
    teamId: string;
    token: string;
    scopes: string[];
    expiresAt?: Date;
    createdAt: Date;
}
/** Default scopes for team-internal agents */
export declare const DEFAULT_SCOPES: readonly ["message:send", "message:read", "task:create", "task:update", "broadcast:send", "group:join", "group:send", "card:read"];
/** All available scopes */
export type Scope = "message:send" | "message:read" | "task:create" | "task:update" | "task:cancel" | "broadcast:send" | "group:join" | "group:leave" | "group:send" | "group:create" | "card:read" | "card:write" | "admin";
/** Check if a token has a required scope */
export declare function hasScope(token: AgentToken, scope: Scope): boolean;
/** Generate a random bearer token */
export declare function generateToken(): string;
//# sourceMappingURL=auth.d.ts.map