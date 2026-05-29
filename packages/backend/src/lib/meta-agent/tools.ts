// ---------------------------------------------------------------------------
// Agent tool definitions + execution
// ---------------------------------------------------------------------------

export interface ToolResult {
  actionType: string;
  payload: Record<string, unknown>;
}

/** Peer agent info passed to tool execution context */
export interface PeerAgent {
  id: string;
  name: string;
  role: string;
}

/** Context available during tool execution */
export interface ToolExecContext {
  teamId: string;
  agentId: string;
  agentName: string;
  peers: PeerAgent[];
}

// ---------------------------------------------------------------------------
// OpenAI-format tool definitions for the agent LLM call
// ---------------------------------------------------------------------------

export const AGENT_TOOL_DEFS = [
  {
    type: "function" as const,
    function: {
      name: "send_message",
      description:
        "Send a direct message to another agent in the team. Use this to coordinate, delegate, share findings, or ask questions.",
      parameters: {
        type: "object",
        properties: {
          to_agent: {
            type: "string",
            description: "Name of the agent to send to (e.g. 'content-scheduler')",
          },
          content: {
            type: "string",
            description: "The message content",
          },
        },
        required: ["to_agent", "content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "broadcast",
      description:
        "Send a message to ALL agents in the team. Use for announcements, status updates, or information everyone needs.",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The broadcast message content",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "report_action",
      description:
        "Report an action you took or a finding from your work. This gets logged to the team's action log and narration feed.",
      parameters: {
        type: "object",
        properties: {
          action_type: {
            type: "string",
            description: "Short label for the action (e.g. 'draft_reply', 'research_summary', 'metrics_check')",
          },
          summary: {
            type: "string",
            description: "Brief description of what you did or found",
          },
          details: {
            type: "object",
            description: "Any structured data relevant to the action",
          },
        },
        required: ["action_type", "summary"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool execution (called after LLM returns tool_calls)
// ---------------------------------------------------------------------------

export interface ToolCallInput {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolExecResult {
  toolName: string;
  success: boolean;
  result: string;
  /** If the tool produced an action to log */
  action?: ToolResult;
}

export type A2AXSender = {
  sendDirect: (teamId: string, from: string, to: string, content: string) => Promise<unknown>;
  broadcast: (teamId: string, from: string, content: string) => Promise<unknown>;
};

export async function executeTool(
  call: ToolCallInput,
  ctx: ToolExecContext,
  a2ax: A2AXSender,
): Promise<ToolExecResult> {
  switch (call.name) {
    case "send_message": {
      const toName = call.arguments.to_agent as string;
      const content = call.arguments.content as string;
      const peer = ctx.peers.find(
        (p) => p.name.toLowerCase() === toName.toLowerCase(),
      );
      if (!peer) {
        return {
          toolName: "send_message",
          success: false,
          result: `Agent "${toName}" not found. Available agents: ${ctx.peers.map((p) => p.name).join(", ")}`,
        };
      }
      await a2ax.sendDirect(ctx.teamId, ctx.agentId, peer.id, content);
      return {
        toolName: "send_message",
        success: true,
        result: `Message sent to ${peer.name}`,
        action: {
          actionType: "message_sent",
          payload: { to: peer.name, toId: peer.id, content },
        },
      };
    }

    case "broadcast": {
      const content = call.arguments.content as string;
      await a2ax.broadcast(ctx.teamId, ctx.agentId, content);
      return {
        toolName: "broadcast",
        success: true,
        result: `Broadcast sent to all ${ctx.peers.length} peers`,
        action: {
          actionType: "broadcast_sent",
          payload: { content, peerCount: ctx.peers.length },
        },
      };
    }

    case "report_action": {
      const actionType = call.arguments.action_type as string;
      const summary = call.arguments.summary as string;
      const details = (call.arguments.details as Record<string, unknown>) ?? {};
      return {
        toolName: "report_action",
        success: true,
        result: `Action logged: ${actionType}`,
        action: {
          actionType,
          payload: { summary, ...details },
        },
      };
    }

    default:
      return {
        toolName: call.name,
        success: false,
        result: `Unknown tool: ${call.name}`,
      };
  }
}
