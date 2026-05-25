// ---------------------------------------------------------------------------
// Auth types — A2A-compatible authentication
// ---------------------------------------------------------------------------

/** A bearer token issued to an agent at spawn time */
export interface AgentToken {
  agentId: string;
  fleetId: string;
  token: string;
  scopes: string[];
  expiresAt?: Date;
  createdAt: Date;
}

/** Default scopes for fleet-internal agents */
export const DEFAULT_SCOPES = [
  "message:send",
  "message:read",
  "task:create",
  "task:update",
  "broadcast:send",
  "group:join",
  "group:send",
  "card:read",
] as const;

/** All available scopes */
export type Scope =
  | "message:send"
  | "message:read"
  | "task:create"
  | "task:update"
  | "task:cancel"
  | "broadcast:send"
  | "group:join"
  | "group:leave"
  | "group:send"
  | "group:create"
  | "card:read"
  | "card:write"
  | "admin";

/** Check if a token has a required scope */
export function hasScope(token: AgentToken, scope: Scope): boolean {
  return token.scopes.includes(scope) || token.scopes.includes("admin");
}

/** Generate a random bearer token */
export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
