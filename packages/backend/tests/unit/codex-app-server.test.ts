import { describe, expect, it, vi } from "vitest";
import {
  CodexAppServerClient,
  CodexAppServerError,
  defaultServerRequestResult,
  type JsonRpcTransport,
} from "@/lib/meta-agent/codex-app-server";

// ---------------------------------------------------------------------------
// Fake transport
// ---------------------------------------------------------------------------

function makeFake() {
  const sent: Array<Record<string, unknown>> = [];
  let lineCb: (line: string) => void = () => {};
  let closeCb: (reason: string) => void = () => {};
  const transport: JsonRpcTransport = {
    send: (line) => sent.push(JSON.parse(line)),
    onLine: (cb) => {
      lineCb = cb;
    },
    onClose: (cb) => {
      closeCb = cb;
    },
    close: vi.fn(),
  };
  return {
    transport,
    sent,
    receive: (obj: Record<string, unknown>) => lineCb(JSON.stringify(obj)),
    receiveRaw: (line: string) => lineCb(line),
    serverClose: (reason: string) => closeCb(reason),
    sentByMethod: (method: string) => sent.filter((m) => m.method === method),
  };
}

/** Let queued microtasks/async handlers settle. */
const settle = () => new Promise((r) => setTimeout(r, 0));

// ---------------------------------------------------------------------------

describe("CodexAppServerClient", () => {
  it("correlates requests and responses by id", async () => {
    const fake = makeFake();
    const client = new CodexAppServerClient(fake.transport);

    const p = client.request("model/list", {});
    const req = fake.sent[0];
    expect(req.method).toBe("model/list");
    expect(req.jsonrpc).toBe("2.0");

    fake.receive({ id: req.id, result: { models: ["gpt-5.5"] } });
    await expect(p).resolves.toEqual({ models: ["gpt-5.5"] });
  });

  it("rejects with CodexAppServerError on an error response", async () => {
    const fake = makeFake();
    const client = new CodexAppServerClient(fake.transport);

    const p = client.request("thread/start", {});
    fake.receive({ id: fake.sent[0].id, error: { code: -32600, message: "bad params" } });

    await expect(p).rejects.toThrow(/thread\/start failed: bad params/);
    await expect(p).rejects.toBeInstanceOf(CodexAppServerError);
  });

  it("initialize sends experimentalApi capability then the initialized notification", async () => {
    const fake = makeFake();
    const client = new CodexAppServerClient(fake.transport);

    const p = client.initialize({ name: "sh", title: "SH", version: "1.0" });
    const init = fake.sent[0];
    expect(init.method).toBe("initialize");
    expect((init.params as Record<string, unknown>).capabilities).toEqual({
      experimentalApi: true,
      requestAttestation: false,
    });

    fake.receive({ id: init.id, result: { codexHome: "/x" } });
    await p;

    expect(fake.sentByMethod("initialized")).toHaveLength(1);
  });

  it("routes server requests to the registered thread handler and replies", async () => {
    const fake = makeFake();
    const client = new CodexAppServerClient(fake.transport);
    const onRequest = vi.fn().mockResolvedValue({ success: true, contentItems: [] });
    client.registerThread("thr_1", { onRequest });

    fake.receive({
      id: 7,
      method: "item/tool/call",
      params: { threadId: "thr_1", callId: "c1", tool: "send_message", arguments: { a: 1 } },
    });
    await settle();

    expect(onRequest).toHaveBeenCalledWith(
      "item/tool/call",
      expect.objectContaining({ tool: "send_message" }),
    );
    const reply = fake.sent.find((m) => m.id === 7);
    expect(reply?.result).toEqual({ success: true, contentItems: [] });
  });

  it("answers unrouted server requests with safe declines", async () => {
    const fake = makeFake();
    new CodexAppServerClient(fake.transport);

    fake.receive({ id: 1, method: "item/tool/call", params: { threadId: "ghost" } });
    fake.receive({ id: 2, method: "item/commandExecution/requestApproval", params: { threadId: "ghost" } });
    fake.receive({ id: 3, method: "mcpServer/elicitation/request", params: { threadId: "ghost" } });
    await settle();

    expect((fake.sent.find((m) => m.id === 1)?.result as Record<string, unknown>).success).toBe(false);
    expect((fake.sent.find((m) => m.id === 2)?.result as Record<string, unknown>).decision).toBe("decline");
    expect((fake.sent.find((m) => m.id === 3)?.result as Record<string, unknown>).action).toBe("decline");
  });

  it("converts a throwing handler into an RPC error response", async () => {
    const fake = makeFake();
    const client = new CodexAppServerClient(fake.transport);
    client.registerThread("thr_1", {
      onRequest: () => {
        throw new Error("handler exploded");
      },
    });

    fake.receive({ id: 9, method: "item/tool/call", params: { threadId: "thr_1" } });
    await settle();

    const reply = fake.sent.find((m) => m.id === 9);
    expect((reply?.error as Record<string, unknown>).message).toBe("handler exploded");
  });

  it("routes notifications by threadId and ignores unrouted/malformed lines", async () => {
    const fake = makeFake();
    const client = new CodexAppServerClient(fake.transport);
    const onNotification = vi.fn();
    client.registerThread("thr_1", { onNotification });

    fake.receive({ method: "turn/completed", params: { threadId: "thr_1", turn: { status: "completed" } } });
    fake.receive({ method: "turn/completed", params: { threadId: "other" } });
    fake.receiveRaw("not json at all");

    expect(onNotification).toHaveBeenCalledTimes(1);
    expect(onNotification).toHaveBeenCalledWith(
      "turn/completed",
      expect.objectContaining({ threadId: "thr_1" }),
    );
  });

  it("stops routing after unregisterThread", async () => {
    const fake = makeFake();
    const client = new CodexAppServerClient(fake.transport);
    const onNotification = vi.fn();
    client.registerThread("thr_1", { onNotification });
    client.unregisterThread("thr_1");

    fake.receive({ method: "item/completed", params: { threadId: "thr_1" } });
    expect(onNotification).not.toHaveBeenCalled();
  });

  it("rejects in-flight requests when the connection closes", async () => {
    const fake = makeFake();
    const client = new CodexAppServerClient(fake.transport);

    const p = client.request("turn/start", { threadId: "t" });
    fake.serverClose("exited (code=1)");

    await expect(p).rejects.toThrow(/connection closed/);
    expect(client.isClosed).toBe(true);
    await expect(client.request("turn/start", {})).rejects.toThrow(/exited/);
  });

  it("times out requests that never get a response", async () => {
    vi.useFakeTimers();
    try {
      const fake = makeFake();
      const client = new CodexAppServerClient(fake.transport);
      const p = client.request("turn/start", {}, { timeoutMs: 50 });
      const assertion = expect(p).rejects.toThrow(/no response within 50ms/);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("defaultServerRequestResult", () => {
  it("fails tool calls closed and declines approvals", () => {
    expect(defaultServerRequestResult("item/tool/call").success).toBe(false);
    expect(defaultServerRequestResult("item/fileChange/requestApproval")).toEqual({
      decision: "decline",
    });
    expect(defaultServerRequestResult("execCommandApproval")).toEqual({ decision: "decline" });
  });
});
