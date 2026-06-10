// ---------------------------------------------------------------------------
// Codex app-server client: JSON-RPC 2.0 over newline-delimited stdio.
//
// This is the transport layer for the "engine mode" codex harness
// (codex-harness.ts). One persistent `codex app-server` process serves many
// concurrent agent threads; RPC flows BOTH ways:
//
//   client → server   initialize, thread/start, thread/resume, turn/start,
//                     turn/interrupt
//   server → client   item/tool/call (dynamic tool execution), the
//                     item/*/requestApproval family, mcpServer/elicitation
//   server → client   notifications: item/started, item/completed,
//                     turn/completed, thread/tokenUsage/updated, ...
//
// Server-initiated traffic is routed to per-thread handlers (params.threadId)
// registered by the harness, so concurrent agents on one shared process don't
// see each other's calls. Unrouted server requests get a safe decline.
//
// Protocol facts verified against codex-cli 0.139.0 (`codex app-server
// generate-ts`) and a live probe: `dynamicTools` on thread/start is gated by
// the `experimentalApi: true` initialize capability.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Minimal transport so tests can drive the client without a subprocess. */
export interface JsonRpcTransport {
  send: (line: string) => void;
  onLine: (cb: (line: string) => void) => void;
  onClose: (cb: (reason: string) => void) => void;
  close: () => void;
}

export interface ThreadHandlers {
  /** Server→client request scoped to this thread. Return value becomes the
   *  RPC result. Throwing produces an RPC error response. */
  onRequest?: (method: string, params: Record<string, unknown>) => Promise<unknown> | unknown;
  /** Notification scoped to this thread. */
  onNotification?: (method: string, params: Record<string, unknown>) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  method: string;
  timer: ReturnType<typeof setTimeout>;
}

export class CodexAppServerError extends Error {
  constructor(
    method: string,
    public readonly code: number | undefined,
    message: string,
  ) {
    super(`codex app-server ${method} failed: ${message}`);
    this.name = "CodexAppServerError";
  }
}

export class CodexAppServerClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly threadHandlers = new Map<string, ThreadHandlers>();
  private closed = false;
  private closeReason = "not closed";

  constructor(private readonly transport: JsonRpcTransport) {
    transport.onLine((line) => {
      this.handleLine(line);
    });
    transport.onClose((reason) => {
      this.handleClose(reason);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Handshake. Must be called once before any thread/turn request. */
  async initialize(clientInfo: { name: string; title: string; version: string }): Promise<unknown> {
    const result = await this.request("initialize", {
      clientInfo,
      // experimentalApi unlocks thread/start.dynamicTools (verified 0.139).
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this.notify("initialized");
    return result;
  }

  request(
    method: string,
    params: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      return Promise.reject(new CodexAppServerError(method, undefined, this.closeReason));
    }
    const id = this.nextId++;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError(method, undefined, `no response within ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        method,
        timer,
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  /** Route server-initiated requests/notifications for one thread. */
  registerThread(threadId: string, handlers: ThreadHandlers): void {
    this.threadHandlers.set(threadId, handlers);
  }

  unregisterThread(threadId: string): void {
    this.threadHandlers.delete(threadId);
  }

  close(): void {
    this.handleClose("closed by client");
    this.transport.close();
  }

  // -------------------------------------------------------------------------

  private send(obj: Record<string, unknown>): void {
    try {
      this.transport.send(`${JSON.stringify(obj)}\n`);
    } catch (err) {
      this.handleClose(err instanceof Error ? err.message : String(err));
    }
  }

  private handleClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new CodexAppServerError(p.method, undefined, `connection closed: ${reason}`));
    }
    this.pending.clear();
    this.threadHandlers.clear();
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return; // stray non-JSON output (logs); ignore
    }

    const hasId = msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === "string" ? msg.method : undefined;

    if (hasId && method) {
      void this.handleServerRequest(msg.id as number | string, method, asRecord(msg.params));
      return;
    }
    if (hasId) {
      const p = this.pending.get(msg.id as number);
      if (!p) return;
      this.pending.delete(msg.id as number);
      clearTimeout(p.timer);
      if (msg.error !== undefined) {
        const err = msg.error as { code?: number; message?: string };
        p.reject(new CodexAppServerError(p.method, err?.code, err?.message ?? "unknown error"));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (method) {
      const params = asRecord(msg.params);
      const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
      const handlers = threadId ? this.threadHandlers.get(threadId) : undefined;
      try {
        handlers?.onNotification?.(method, params);
      } catch (err) {
        console.error(`[codex-app-server] notification handler failed (${method}):`, err);
      }
    }
  }

  private async handleServerRequest(
    id: number | string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    const handlers = threadId ? this.threadHandlers.get(threadId) : undefined;

    if (handlers?.onRequest) {
      try {
        const result = await handlers.onRequest(method, params);
        this.send({ jsonrpc: "2.0", id, result: result ?? {} });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
      }
      return;
    }

    // No handler for this thread: answer with the safest possible default so
    // the server never hangs on us.
    this.send({ jsonrpc: "2.0", id, result: defaultServerRequestResult(method) });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Fail-closed defaults for unrouted server→client requests. */
export function defaultServerRequestResult(method: string): Record<string, unknown> {
  if (method === "item/tool/call") {
    return {
      success: false,
      contentItems: [{ type: "inputText", text: "Tool unavailable: no handler registered." }],
    };
  }
  if (method === "mcpServer/elicitation/request") {
    return { action: "decline", content: null, _meta: null };
  }
  // item/commandExecution/requestApproval, item/fileChange/requestApproval,
  // item/permissions/requestApproval, execCommandApproval, applyPatchApproval
  return { decision: "decline" };
}

// ---------------------------------------------------------------------------
// Subprocess transport + isolated CODEX_HOME
// ---------------------------------------------------------------------------

/**
 * Prepare an isolated CODEX_HOME so agent threads don't inherit the user's
 * personal MCP servers, plugins, skills, or hooks from ~/.codex. Auth is
 * copied in (and refreshed copies stay local to the isolated home, so agent
 * token refreshes can't rotate the user's interactive CLI session out from
 * under them — the same conflict Hermes documents).
 */
export function ensureIsolatedCodexHome(baseDir: string): string {
  const home = join(baseDir, "codex-home");
  mkdirSync(home, { recursive: true });
  const authTarget = join(home, "auth.json");
  if (!existsSync(authTarget)) {
    const userAuth = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
    if (existsSync(userAuth)) copyFileSync(userAuth, authTarget);
  }
  const configPath = join(home, "config.toml");
  if (!existsSync(configPath)) {
    writeFileSync(configPath, "# Simple Harmonic isolated codex home (no user MCP servers/plugins)\n");
  }
  return home;
}

export function spawnCodexAppServer(opts?: {
  codexHome?: string;
  command?: string;
}): CodexAppServerClient {
  const child = spawn(opts?.command ?? "codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...(opts?.codexHome ? { CODEX_HOME: opts.codexHome } : {}),
      RUST_LOG: process.env.RUST_LOG ?? "error",
    },
  });

  let stderrTail = "";
  child.stderr?.on("data", (d: Buffer) => {
    stderrTail = (stderrTail + d.toString()).slice(-2000);
  });

  const lineCbs: Array<(line: string) => void> = [];
  const closeCbs: Array<(reason: string) => void> = [];
  if (child.stdout) {
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      for (const cb of lineCbs) cb(line);
    });
  }
  child.on("error", (err) => {
    for (const cb of closeCbs) cb(`spawn failed: ${err.message}`);
  });
  child.on("exit", (code, signal) => {
    const why = `exited (code=${code}, signal=${signal}) ${stderrTail.slice(-300)}`.trim();
    for (const cb of closeCbs) cb(why);
  });

  const transport: JsonRpcTransport = {
    send: (line) => {
      if (!child.stdin?.writable) throw new Error("codex app-server stdin not writable");
      child.stdin.write(line);
    },
    onLine: (cb) => lineCbs.push(cb),
    onClose: (cb) => closeCbs.push(cb),
    close: () => {
      child.kill("SIGTERM");
    },
  };

  return new CodexAppServerClient(transport);
}
