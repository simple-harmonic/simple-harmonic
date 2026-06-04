// ---------------------------------------------------------------------------
// observe_app tool -- lets agents query the app's health events.
//
// Agents can see recent errors, warnings, and info events. This is the
// active-query complement to the passive health-context injection in the
// tick prompt. Use it when an agent wants to investigate a specific error
// or check if a fix resolved an issue.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolDefinition, ToolImpl } from "../../lib/meta-agent/registry";
import { queryAppEvents, formatEventsForPrompt } from "../app-events";

const observeAppSchema = z.object({
  severity: z
    .enum(["info", "warning", "error"])
    .optional()
    .describe("Filter by severity. Omit for all severities."),
  source: z
    .string()
    .optional()
    .describe("Filter by source (e.g. 'tick', 'tool', 'api', 'test'). Omit for all sources."),
  hours: z
    .number()
    .optional()
    .describe("How many hours back to look. Default 1 hour, max 24."),
  limit: z
    .number()
    .optional()
    .describe("Max events to return. Default 20, max 50."),
});

export const observeAppDef: ToolDefinition<typeof observeAppSchema> = {
  name: "observe_app",
  description:
    "Query recent app health events (errors, warnings, status updates). Use this to investigate issues, check if a fix resolved an error, or understand what's happening in the system. Returns events newest-first.",
  category: "internal",
  risk: "safe",
  schema: observeAppSchema,
};

export const observeAppImpl: ToolImpl<typeof observeAppSchema> = async (args, ctx) => {
  const hours = Math.min(args.hours ?? 1, 24);
  const limit = Math.min(args.limit ?? 20, 50);
  const since = new Date(Date.now() - hours * 3600000);

  try {
    const events = await queryAppEvents({
      teamId: ctx.teamId,
      severity: args.severity,
      source: args.source,
      since,
      limit,
    });

    if (events.length === 0) {
      return {
        toolName: "observe_app",
        success: true,
        result: `No events found in the last ${hours} hour(s)${args.severity ? ` with severity=${args.severity}` : ""}${args.source ? ` from source=${args.source}` : ""}.`,
      };
    }

    const formatted = formatEventsForPrompt(events);
    return {
      toolName: "observe_app",
      success: true,
      result: `${events.length} event(s) in the last ${hours} hour(s):\n\n${formatted}`,
      action: {
        actionType: "app_observed",
        payload: {
          eventCount: events.length,
          hours,
          filters: { severity: args.severity, source: args.source },
        },
      },
    };
  } catch (err) {
    return {
      toolName: "observe_app",
      success: false,
      result: `observe_app failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};
