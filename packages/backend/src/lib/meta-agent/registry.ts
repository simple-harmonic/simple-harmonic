// ---------------------------------------------------------------------------
// Tool registry — the plugin surface for agent tools.
//
// A tool has two halves, deliberately split (v0.1 eng review D8):
//   - DEFINITION (name, description, category, risk, Zod schema) — pure data,
//     lives in this library and is safe to extract to NPM at v0.2.
//   - IMPLEMENTATION (the function that actually does the I/O) — registered
//     alongside the definition. App-specific impls (fs, shell, http) live in
//     packages/backend/src/server/tools/ and are registered there; the
//     internal message-passing tools live in ./default-tools.
//
// The registry validates LLM-supplied arguments against the Zod schema before
// calling the impl, and converts schemas to OpenAI/JSON-Schema tool defs for
// the LLM call. Validation happens here so a malformed call becomes a
// structured error result the runner can feed back to the model, never a throw.
//
//   register(def, impl) ──► tools: Map<name, {def, impl}>
//                              │
//        getOpenAIDefs() ◄─────┤  (Zod → JSON Schema, for the LLM `tools` arg)
//        listForAgent()  ◄─────┤  (filter to an agent's allowlist)
//        execute(name,raw,ctx)─┘  (Zod.safeParse → impl, or error result)
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { OpenAIToolDef } from "./types";
import type { ToolExecResult, ToolRunContext } from "./tools";

/** Broad grouping used for allowlisting and risk display. */
export type ToolCategory = "internal" | "filesystem" | "shell" | "network";

/**
 * "safe" tools run without approval. "destructive" tools (writes, shell,
 * mutating API calls) must pass the approval gate before their impl runs —
 * the gate wiring lands in T2; the registry just carries the label.
 */
export type ToolRisk = "safe" | "destructive";

/** The data half of a tool: everything the LLM and approval gate need. */
export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  category: ToolCategory;
  risk: ToolRisk;
  /** Zod schema for the tool's arguments. Also the source of its JSON Schema. */
  schema: S;
}

/** The behavior half: runs after args are validated against the schema. */
export type ToolImpl<S extends z.ZodType = z.ZodType> = (
  args: z.infer<S>,
  ctx: ToolRunContext,
) => Promise<ToolExecResult>;

interface RegisteredTool {
  def: ToolDefinition;
  impl: ToolImpl;
}

/**
 * Convert a Zod schema to a JSON Schema object suitable for an OpenAI/Anthropic
 * tool parameter block. Strips the `$schema` meta key, which the LLM APIs don't
 * want and Anthropic's input_schema rejects.
 */
export function schemaToParameters(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  /**
   * Register a tool definition with its implementation. Throws on a duplicate
   * name — silent overwrite would let one plugin shadow another's tool, which
   * is exactly the kind of bug that's invisible until an agent calls the wrong
   * code. Fail loud at registration instead.
   */
  register<S extends z.ZodType>(def: ToolDefinition<S>, impl: ToolImpl<S>): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool "${def.name}" is already registered`);
    }
    this.tools.set(def.name, {
      def: def as ToolDefinition,
      impl: impl as ToolImpl,
    });
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.def;
  }

  /**
   * Definitions for the tools an agent may use. With no allowlist, returns all
   * registered tools. With an allowlist, returns only those that are both
   * registered and allowed (unknown names in the allowlist are ignored).
   */
  listForAgent(allowed?: string[]): ToolDefinition[] {
    const defs = [...this.tools.values()].map((t) => t.def);
    if (!allowed) return defs;
    const set = new Set(allowed);
    return defs.filter((d) => set.has(d.name));
  }

  /** OpenAI-format tool defs for the LLM `tools` argument, allowlist-filtered. */
  getOpenAIDefs(allowed?: string[]): OpenAIToolDef[] {
    return this.listForAgent(allowed).map((d) => ({
      type: "function",
      function: {
        name: d.name,
        description: d.description,
        parameters: schemaToParameters(d.schema),
      },
    }));
  }

  /**
   * Whether a tool requires human approval before running: true if the tool is
   * registered with risk "destructive", OR if it is unknown (fail safe — an
   * unrecognized tool name is never auto-approved). Pass this to
   * approveAgentAction / runAgent({ isDestructive }) to back the approval gate
   * with the registry's risk labels.
   */
  isDestructive = (toolName: string): boolean => {
    const tool = this.tools.get(toolName);
    if (!tool) return true;
    return tool.def.risk === "destructive";
  };

  /**
   * Validate raw LLM arguments against the tool's schema, then run its impl.
   * Never throws: an unknown tool or a schema-validation failure comes back as
   * a `success: false` result whose `result` string explains the problem, so
   * the runner can hand it to the LLM for self-correction.
   */
  async execute(
    name: string,
    rawArgs: unknown,
    ctx: ToolRunContext,
  ): Promise<ToolExecResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        toolName: name,
        success: false,
        result: `Unknown tool: ${name}`,
      };
    }

    const parsed = tool.def.schema.safeParse(rawArgs);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
        .join("; ");
      return {
        toolName: name,
        success: false,
        result: `Invalid arguments for ${name}: ${issues}. Retry with arguments matching the tool schema.`,
      };
    }

    return tool.impl(parsed.data, ctx);
  }
}
