// ---------------------------------------------------------------------------
// Agent tool types + the back-compat dispatch surface.
//
// The source of truth for tools is now the ToolRegistry (./registry) loaded
// with the internal tools by createDefaultRegistry (./default-tools). This
// file keeps the original `AGENT_TOOL_DEFS` and `executeTool(call, ctx, a2ax)`
// exports as thin shims over a default registry instance, so existing callers
// (and tests) keep working unchanged while there is a single implementation
// underneath — no parallel switch + registry systems.
// ---------------------------------------------------------------------------

import { createDefaultRegistry } from "./default-tools";

export interface ToolResult {
  actionType: string;
  payload: Record<string, unknown>;
}

/** Peer agent info passed to tool execution context. */
export interface PeerAgent {
  id: string;
  name: string;
  role: string;
}

/**
 * Context available to a tool's public callers. Does NOT carry the a2ax sender
 * — back-compat callers pass that separately to executeTool, which merges it
 * into the ToolRunContext the registry impls receive.
 */
export interface ToolExecContext {
  teamId: string;
  agentId: string;
  agentName: string;
  peers: PeerAgent[];
}

/** What a registry tool implementation actually receives: ctx + the a2ax bus. */
export interface ToolRunContext extends ToolExecContext {
  a2ax: A2AXSender;
}

export interface ToolCallInput {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolExecResult {
  toolName: string;
  success: boolean;
  result: string;
  /** If the tool produced an action to log. */
  action?: ToolResult;
}

export type A2AXSender = {
  sendDirect: (
    teamId: string,
    from: string,
    to: string,
    content: string,
  ) => Promise<unknown>;
  broadcast: (teamId: string, from: string, content: string) => Promise<unknown>;
};

// ---------------------------------------------------------------------------
// Default registry + back-compat exports
// ---------------------------------------------------------------------------

/**
 * Process-wide default registry, pre-loaded with the internal tools. The
 * internal tools are stateless (a2ax arrives via ctx), so a single shared
 * instance is safe. The app builds on this via createDefaultRegistry() when it
 * needs the filesystem/shell/network tools too.
 */
const defaultRegistry = createDefaultRegistry();

/** OpenAI-format defs for the internal tools, for the LLM `tools` argument. */
export const AGENT_TOOL_DEFS = defaultRegistry.getOpenAIDefs();

/**
 * Execute one tool call against the default registry. Kept at its original
 * 3-arg shape — args validated by the registry against the tool's Zod schema,
 * with a2ax merged into the run context.
 */
export async function executeTool(
  call: ToolCallInput,
  ctx: ToolExecContext,
  a2ax: A2AXSender,
): Promise<ToolExecResult> {
  return defaultRegistry.execute(call.name, call.arguments, { ...ctx, a2ax });
}
