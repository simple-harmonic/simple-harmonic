/** Channel types */
export type ChannelType = "direct" | "broadcast" | "group" | "task";
/** Message delivery status */
export type MessageStatus = "pending" | "delivered" | "read" | "expired";
/** Role of the message sender */
export type MessageRole = "agent" | "meta" | "system" | "user";
/** General message kinds */
export type GeneralKind = "text" | "data" | "artifact" | "ack" | "error";
/** Task-specific message kinds */
export type TaskKind = "task.create" | "task.accept" | "task.status" | "task.input_required" | "task.result" | "task.cancel" | "task.reject";
/** System kinds */
export type SystemKind = "system.join" | "system.leave" | "system.created";
/** All message kinds */
export type MessageKind = GeneralKind | TaskKind | SystemKind;
/** A Part is a unit of content (A2A-compatible) */
export interface Part {
    /** Exactly one content field should be set */
    text?: string;
    raw?: string;
    url?: string;
    data?: Record<string, unknown>;
    /** Optional metadata */
    mediaType?: string;
    filename?: string;
    metadata?: Record<string, unknown>;
}
/** An Artifact is a named collection of output parts */
export interface Artifact {
    artifactId: string;
    name?: string;
    description?: string;
    parts: Part[];
    metadata?: Record<string, unknown>;
}
/** The core message envelope */
export interface Message {
    id: string;
    fleetId: string;
    channelType: ChannelType;
    channelId: string;
    fromAgentId: string;
    role: MessageRole;
    kind: MessageKind;
    /** Primary text content (convenience field, also representable as parts) */
    content: string;
    /** Structured parts (A2A-compatible) */
    parts?: Part[];
    /** Output artifacts */
    artifacts?: Artifact[];
    /** Structured payload (for backward compat and simple use cases) */
    payload?: Record<string, unknown>;
    /** Thread reply */
    replyTo?: string;
    /** Delivery status */
    status: MessageStatus;
    /** If true, wakes recipient agent on next available tick */
    urgent?: boolean;
    /** Message expires after this time */
    expiresAt?: Date | null;
    createdAt: Date;
}
/** Input for creating a new message */
export interface CreateMessageInput {
    fleetId: string;
    channelType: ChannelType;
    channelId: string;
    fromAgentId: string;
    role?: MessageRole;
    kind: MessageKind;
    content: string;
    parts?: Part[];
    artifacts?: Artifact[];
    payload?: Record<string, unknown>;
    replyTo?: string;
    urgent?: boolean;
    expiresAt?: Date | null;
}
//# sourceMappingURL=message.d.ts.map