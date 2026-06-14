// ---------------------------------------------------------------------------
// LLM provider resolution. Builds the cascade of every configured provider,
// in priority order:
//
//   1. Codex (when signed in via codex) — `codex app-server` wrapped as an
//      LLMClient (one turn per call); the agent tick drives codex via engine
//      mode (runCodexAgentTick) directly. This candidate serves chat / planner /
//      test-llm.
//   2. Anthropic (ANTHROPIC_API_KEY)
//   3. OpenRouter (OPENROUTER_API_KEY) — one cascade step per configured model
//   4. OpenAI platform key (config file or OPENAI_API_KEY)
//
// The tick wraps the chain in a single cascading client (lib/meta-agent/
// cascade.ts): a provider error on one step falls through to the next, so one
// down or rate-limited provider can't stall every agent while another key is
// configured.
// ---------------------------------------------------------------------------

import OpenAI from "openai";
import { createAnthropicClient } from "../lib/meta-agent/anthropic-adapter";
import {
  type CascadeOptions,
  createCascadeLLM,
  type LLMCandidate,
} from "../lib/meta-agent/cascade";
import { createCodexAppServerClient } from "../lib/meta-agent/codex-harness";
import type { LLMClient } from "../lib/meta-agent/runner";
import { getApiKeySource, getConfig } from "./config";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const DEFAULT_CODEX_MODEL = "gpt-5.5";
const DEFAULT_ANTHROPIC_MODEL = "claude-sonnet-4-20250514";
// OpenRouter ids are vendor-namespaced; this is the same model family the
// direct Anthropic path defaults to.
const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-4";
const DEFAULT_TIMEOUT_MS = 120_000;

export interface ResolveOptions {
  /** Per-request client timeout. Default 120s (matches the tick budget). */
  timeoutMs?: number;
}

/**
 * Every configured provider as a cascade candidate, in priority order. Always
 * returns at least one candidate: with nothing configured it falls back to a
 * key-less OpenAI client, which surfaces a clear auth error on first call
 * (the pre-cascade behavior) rather than failing at resolve time.
 */
export function resolveLLMCandidates(
  opts: ResolveOptions = {},
): LLMCandidate[] {
  const cfg = getConfig();
  const source = getApiKeySource();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const candidates: LLMCandidate[] = [];

  if (source === "codex") {
    // Codex via app-server, wrapped as an LLMClient (one turn per call). The
    // agent tick drives codex via engine mode (runCodexAgentTick) directly;
    // this candidate serves the other cascade callers: chat, planner, test-llm.
    const model = cfg.model || DEFAULT_CODEX_MODEL;
    candidates.push({
      provider: "codex",
      model,
      llm: createCodexAppServerClient({ model }),
    });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    candidates.push({
      provider: "anthropic",
      model: process.env.ANTHROPIC_MODEL || DEFAULT_ANTHROPIC_MODEL,
      llm: createAnthropicClient({ apiKey: anthropicKey, timeout }),
    });
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    const llm = new OpenAI({
      apiKey: openrouterKey,
      baseURL: process.env.OPENROUTER_BASE_URL || OPENROUTER_BASE_URL,
      timeout,
    }) as unknown as LLMClient;
    // Primary model plus optional comma-separated fallbacks, each its own
    // cascade step so the chain walks them in order.
    const models = [
      process.env.OPENROUTER_MODEL || DEFAULT_OPENROUTER_MODEL,
      ...(process.env.OPENROUTER_FALLBACK_MODELS ?? "").split(","),
    ]
      .map((m) => m.trim())
      .filter(Boolean);
    for (const model of new Set(models)) {
      candidates.push({ provider: "openrouter", model, llm });
    }
  }

  // Direct OpenAI(-compatible) platform key. Skipped under the codex source:
  // there cfg.openaiApiKey holds the ChatGPT token, not a platform key.
  if (source === "config" || source === "env") {
    candidates.push({
      provider: "openai",
      model: cfg.model,
      llm: new OpenAI({
        apiKey: cfg.openaiApiKey || undefined,
        baseURL: cfg.openaiBaseUrl || undefined,
        timeout,
      }) as unknown as LLMClient,
    });
  }

  if (candidates.length === 0) {
    candidates.push({
      provider: "openai",
      model: cfg.model,
      llm: new OpenAI({
        apiKey: cfg.openaiApiKey || undefined,
        baseURL: cfg.openaiBaseUrl || undefined,
        timeout,
      }) as unknown as LLMClient,
    });
  }

  return candidates;
}

export interface ResolvedLLM {
  llm: LLMClient;
  /** The primary candidate's model id (the tick's modelOverride). */
  model: string;
  /** "provider/model" per cascade step, for logs and status surfaces. */
  chain: string[];
}

/** Resolve all configured providers into a single cascading LLM client. */
export function resolveLLM(
  opts: CascadeOptions & ResolveOptions = {},
): ResolvedLLM {
  const candidates = resolveLLMCandidates(opts);
  return {
    llm: createCascadeLLM(candidates, opts),
    model: candidates[0].model,
    chain: candidates.map((c) => `${c.provider}/${c.model}`),
  };
}
