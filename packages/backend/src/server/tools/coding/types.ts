// ---------------------------------------------------------------------------
// Coding backend interface: the contract all coding CLI adapters implement.
//
// Each backend (Codex, Claude Code, OpenCode) translates its CLI's output
// into this common shape. The coding_task tool consumes CodingResult and
// doesn't know which backend produced it.
// ---------------------------------------------------------------------------

export interface CodingRunOpts {
  task: string;
  cwd: string;
  model?: string;
  /** Timeout in milliseconds. Backends default to 300_000 (5 min) if not set. */
  timeout?: number;
  signal?: AbortSignal;
}

export interface CodingResult {
  messages: string[];
  commands: Array<{ command: string; output: string; exitCode: number }>;
  errors: string[];
}

export interface CodingBackend {
  name: string;
  run(opts: CodingRunOpts): Promise<CodingResult>;
}
