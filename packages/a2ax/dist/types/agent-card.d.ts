/** Agent capability flags */
export interface AgentCapabilities {
    streaming: boolean;
    pushNotifications: boolean;
    extendedAgentCard: boolean;
    /** a2ax extension: agent supports broadcast channel */
    broadcast?: boolean;
    /** a2ax extension: agent supports group channels */
    groups?: boolean;
    /** a2ax extension: agent supports task management */
    tasks?: boolean;
}
/** A skill the agent can perform */
export interface AgentSkill {
    id: string;
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    acceptedMediaTypes?: string[];
}
/** Provider information */
export interface AgentProvider {
    name: string;
    url?: string;
    contact?: string;
}
/** Security scheme (OpenAPI-compatible) */
export interface SecurityScheme {
    type: "apiKey" | "http" | "oauth2" | "openIdConnect" | "mutualTls";
    /** For apiKey: header name or query param name */
    name?: string;
    /** For apiKey: "header" | "query" */
    in?: "header" | "query";
    /** For http: "bearer" | "basic" */
    scheme?: string;
    bearerFormat?: string;
    /** For oauth2 */
    flows?: OAuthFlows;
    /** For openIdConnect */
    openIdConnectUrl?: string;
    /** For mutualTls */
    certificateUrl?: string;
    description?: string;
}
export interface OAuthFlows {
    authorizationCode?: OAuthFlow;
    clientCredentials?: OAuthFlow;
    deviceCode?: OAuthFlow;
}
export interface OAuthFlow {
    authorizationUrl?: string;
    tokenUrl: string;
    refreshUrl?: string;
    scopes: Record<string, string>;
}
/** Card signature for verification */
export interface AgentCardSignature {
    algorithm: string;
    signature: string;
    keyId?: string;
}
/** The full Agent Card */
export interface AgentCard {
    id: string;
    name: string;
    description?: string;
    provider?: AgentProvider;
    endpoint: string;
    capabilities: AgentCapabilities;
    skills: AgentSkill[];
    securitySchemes?: Record<string, SecurityScheme>;
    security?: Record<string, string[]>[];
    signature?: AgentCardSignature;
    metadata?: Record<string, unknown>;
}
/** Create a minimal agent card with sensible defaults */
export declare function createAgentCard(opts: Pick<AgentCard, "id" | "name" | "endpoint"> & Partial<AgentCard>): AgentCard;
//# sourceMappingURL=agent-card.d.ts.map