// ---------------------------------------------------------------------------
// Cascade LLM client: composes an ordered list of (provider, model, client)
// candidates into a single LLMClient. Each completion call tries the chain in
// order and falls through to the next candidate on any provider error, so one
// rate-limited or down provider can't fail an agent tick while another key is
// configured. Provider resolution lives in server/llm.ts; this module is
// library core and must not import server modules.
// ---------------------------------------------------------------------------

import type { LLMClient } from "./runner";

export interface LLMCandidate {
  /** Short provider id for logs/events (e.g. "anthropic", "openrouter"). */
  provider: string;
  /** Model id sent to this provider; overrides params.model per attempt. */
  model: string;
  llm: LLMClient;
}

export interface CascadeOptions {
  /** Called once per failed candidate, before the next one is tried. */
  onFallback?: (info: {
    provider: string;
    model: string;
    error: unknown;
    /** The candidate that will be tried next, absent on the last failure. */
    next?: { provider: string; model: string };
  }) => void;
}

export function createCascadeLLM(
  candidates: LLMCandidate[],
  opts: CascadeOptions = {},
): LLMClient {
  if (candidates.length === 0) {
    throw new Error("createCascadeLLM requires at least one candidate");
  }

  return {
    chat: {
      completions: {
        create: async (params, options) => {
          let lastErr: unknown;
          for (let i = 0; i < candidates.length; i++) {
            const c = candidates[i];
            try {
              const res = await c.llm.chat.completions.create(
                { ...params, model: c.model },
                options,
              );
              // Stamp the serving model so the spend counter attributes
              // fallback calls to the model that actually ran.
              const r = res as { model?: string };
              if (!r.model) r.model = c.model;
              return res;
            } catch (err) {
              lastErr = err;
              // The caller's wall-clock budget aborted the call: stop now
              // instead of burning the rest of the budget on more providers.
              if (options?.signal?.aborted) throw err;
              const next = candidates[i + 1];
              try {
                opts.onFallback?.({
                  provider: c.provider,
                  model: c.model,
                  error: err,
                  next: next ? { provider: next.provider, model: next.model } : undefined,
                });
              } catch {
                // A buggy observer must never break a tick.
              }
            }
          }
          throw lastErr;
        },
      },
    },
  };
}
