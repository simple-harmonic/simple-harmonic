import type { PlannerDeps } from "../lib/meta-agent/planner";
import { getCodexAccessToken, getCodexAuthStatus } from "./codex-auth";
import { getApiKeySource, getConfig } from "./config";
import { proxyFetch } from "./proxy-fetch";

/**
 * Resolve the planner's dependencies from the app's server modules. Keeps the
 * server <-> library wiring in one place so the library core (planner.ts) stays
 * free of server/ imports and remains NPM-extractable.
 */
export function buildPlannerDeps(): PlannerDeps {
  const cfg = getConfig();
  return {
    config: {
      model: cfg.model,
      openaiApiKey: cfg.openaiApiKey,
      openaiBaseUrl: cfg.openaiBaseUrl,
    },
    apiKeySource: getApiKeySource(),
    codexAccessToken: getCodexAccessToken(),
    codexAccountId: getCodexAuthStatus().accountId || "",
    fetchImpl: proxyFetch,
  };
}
