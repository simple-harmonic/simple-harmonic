// ---------------------------------------------------------------------------
// Shared OpenAI-wire-format types for the meta-agent library.
//
// The runner speaks an OpenAI-shaped calling convention (chat.completions with
// `tools`). The Anthropic and Codex adapters translate that shape into their
// own provider formats. These types are the single source of truth for the
// wire format so the adapters can't drift from each other.
// ---------------------------------------------------------------------------

/** OpenAI-style function/tool definition passed in the `tools` array. */
export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}
