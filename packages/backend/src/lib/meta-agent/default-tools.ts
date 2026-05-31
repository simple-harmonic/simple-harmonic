// ---------------------------------------------------------------------------
// Default (internal) tools — the message-passing tools every agent has.
//
// These are the v0.0 tools (send_message, broadcast, report_action) re-expressed
// as registry entries with Zod schemas. They are "internal": they only touch
// the a2ax bus and the action log, never the outside world, so they are `safe`
// and never pass through the approval gate (mirrors approval.ts INTERNAL_TOOLS).
//
// Their impls read the a2ax sender from the run context (ctx.a2ax), which keeps
// this library free of any concrete a2ax/server dependency — the sender is
// injected by the runner.
// ---------------------------------------------------------------------------

import { z } from "zod";
import { ToolRegistry } from "./registry";

const sendMessageSchema = z.object({
  to_agent: z
    .string()
    .describe("Name of the agent to send to (e.g. 'content-scheduler')"),
  content: z.string().describe("The message content"),
});

const broadcastSchema = z.object({
  content: z.string().describe("The broadcast message content"),
});

const reportActionSchema = z.object({
  action_type: z
    .string()
    .describe(
      "Short label for the action (e.g. 'draft_reply', 'research_summary', 'metrics_check')",
    ),
  summary: z.string().describe("Brief description of what you did or found"),
  details: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Any structured data relevant to the action"),
});

/**
 * Build a registry pre-loaded with the three internal tools. The runner uses
 * one of these as its default; the app extends it with the filesystem/shell/
 * network tools (T1 app-side work) before passing it in.
 */
export function createDefaultRegistry(): ToolRegistry {
  const registry = new ToolRegistry();

  registry.register(
    {
      name: "send_message",
      description:
        "Send a direct message to another agent in the team. Use this to coordinate, delegate, share findings, or ask questions.",
      category: "internal",
      risk: "safe",
      schema: sendMessageSchema,
    },
    async (args, ctx) => {
      const peer = ctx.peers.find(
        (p) => p.name.toLowerCase() === args.to_agent.toLowerCase(),
      );
      if (!peer) {
        return {
          toolName: "send_message",
          success: false,
          result: `Agent "${args.to_agent}" not found. Available agents: ${ctx.peers.map((p) => p.name).join(", ")}`,
        };
      }
      await ctx.a2ax.sendDirect(ctx.teamId, ctx.agentId, peer.id, args.content);
      return {
        toolName: "send_message",
        success: true,
        result: `Message sent to ${peer.name}`,
        action: {
          actionType: "message_sent",
          payload: { to: peer.name, toId: peer.id, content: args.content },
        },
      };
    },
  );

  registry.register(
    {
      name: "broadcast",
      description:
        "Send a message to ALL agents in the team. Use for announcements, status updates, or information everyone needs.",
      category: "internal",
      risk: "safe",
      schema: broadcastSchema,
    },
    async (args, ctx) => {
      await ctx.a2ax.broadcast(ctx.teamId, ctx.agentId, args.content);
      return {
        toolName: "broadcast",
        success: true,
        result: `Broadcast sent to all ${ctx.peers.length} peers`,
        action: {
          actionType: "broadcast_sent",
          payload: { content: args.content, peerCount: ctx.peers.length },
        },
      };
    },
  );

  registry.register(
    {
      name: "report_action",
      description:
        "Report an action you took or a finding from your work. This gets logged to the team's action log and narration feed.",
      category: "internal",
      risk: "safe",
      schema: reportActionSchema,
    },
    async (args) => {
      const details = args.details ?? {};
      return {
        toolName: "report_action",
        success: true,
        result: `Action logged: ${args.action_type}`,
        action: {
          actionType: args.action_type,
          payload: { summary: args.summary, ...details },
        },
      };
    },
  );

  return registry;
}
