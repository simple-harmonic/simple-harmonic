// ---------------------------------------------------------------------------
// Route manifest for the standalone backend server.
//
// Every entry mirrors a Next.js route under src/app/api/** (which are now thin
// re-export adapters over the same handler modules). `:name` segments capture
// path params and are handed to handlers as `{ params: Promise<{...}> }`,
// matching the Next.js route-handler contract.
//
// When adding an API route, add it here AND as a wrapper under src/app/api/
// (the route-parity unit test fails if the two surfaces drift).
// ---------------------------------------------------------------------------

import * as agentById from "../api/agent/id";
import * as chat from "../api/chat";
import * as infraReport from "../api/infra-report";
import * as login from "../api/login";
import * as seed from "../api/seed";
import * as settings from "../api/settings/index";
import * as settingsCodex from "../api/settings/codex";
import * as settingsCodexLogin from "../api/settings/codex-login";
import * as settingsCoding from "../api/settings/coding";
import * as settingsConnectors from "../api/settings/connectors";
import * as settingsCredentials from "../api/settings/credentials";
import * as settingsPlatformStatus from "../api/settings/platform-status";
import * as settingsSetupDb from "../api/settings/setup-db";
import * as settingsSkills from "../api/settings/skills";
import * as settingsTelemetry from "../api/settings/telemetry";
import * as settingsTestDb from "../api/settings/test-db";
import * as settingsTestLlm from "../api/settings/test-llm";
import * as spawn from "../api/spawn";
import * as teamById from "../api/team/id/index";
import * as teamAgentHub from "../api/team/id/agent-hub";
import * as teamApprovals from "../api/team/id/approvals";
import * as teamConversations from "../api/team/id/conversations";
import * as teamHeartbeat from "../api/team/id/heartbeat";
import * as teamMessages from "../api/team/id/messages";
import * as teamNarration from "../api/team/id/narration";
import * as teamPause from "../api/team/id/pause";
import * as teamTasks from "../api/team/id/tasks";
import * as teamTrace from "../api/team/id/trace";
import * as teams from "../api/teams";
import * as tick from "../api/tick";

export type RouteHandler = (
  req: Request,
  ctx: { params: Promise<Record<string, string>> },
) => Response | Promise<Response>;

/** Handler modules export per-method functions with narrower param types. */
export interface RouteModule {
  GET?: unknown;
  POST?: unknown;
  PUT?: unknown;
  PATCH?: unknown;
  DELETE?: unknown;
}

export interface RouteEntry {
  pattern: string;
  module: RouteModule;
}

export const routes: RouteEntry[] = [
  { pattern: "/api/agent/:id", module: agentById },
  { pattern: "/api/chat", module: chat },
  { pattern: "/api/infra-report", module: infraReport },
  { pattern: "/api/login", module: login },
  { pattern: "/api/seed", module: seed },
  { pattern: "/api/settings", module: settings },
  { pattern: "/api/settings/codex", module: settingsCodex },
  { pattern: "/api/settings/codex-login", module: settingsCodexLogin },
  { pattern: "/api/settings/coding", module: settingsCoding },
  { pattern: "/api/settings/connectors", module: settingsConnectors },
  { pattern: "/api/settings/credentials", module: settingsCredentials },
  { pattern: "/api/settings/platform-status", module: settingsPlatformStatus },
  { pattern: "/api/settings/setup-db", module: settingsSetupDb },
  { pattern: "/api/settings/skills", module: settingsSkills },
  { pattern: "/api/settings/telemetry", module: settingsTelemetry },
  { pattern: "/api/settings/test-db", module: settingsTestDb },
  { pattern: "/api/settings/test-llm", module: settingsTestLlm },
  { pattern: "/api/spawn", module: spawn },
  { pattern: "/api/team/:id", module: teamById },
  { pattern: "/api/team/:id/agent-hub", module: teamAgentHub },
  { pattern: "/api/team/:id/approvals", module: teamApprovals },
  { pattern: "/api/team/:id/conversations", module: teamConversations },
  { pattern: "/api/team/:id/heartbeat", module: teamHeartbeat },
  { pattern: "/api/team/:id/messages", module: teamMessages },
  { pattern: "/api/team/:id/narration", module: teamNarration },
  { pattern: "/api/team/:id/pause", module: teamPause },
  { pattern: "/api/team/:id/tasks", module: teamTasks },
  { pattern: "/api/team/:id/trace", module: teamTrace },
  { pattern: "/api/teams", module: teams },
  { pattern: "/api/tick", module: tick },
];

/** Match a pathname against a `:param` pattern; returns captured params or null. */
export function matchPath(pattern: string, pathname: string): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    if (p.startsWith(":")) {
      try {
        params[p.slice(1)] = decodeURIComponent(pathParts[i]);
      } catch {
        return null; // malformed percent-encoding → no match (404), not a 500
      }
    } else if (p !== pathParts[i]) {
      return null;
    }
  }
  return params;
}
