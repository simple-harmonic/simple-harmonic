import { describe, expect, it, vi } from "vitest";
import { runAgent } from "@/lib/meta-agent/runner";
import type {
  AgentConfig,
  AgentSuspension,
  LLMClient,
} from "@/lib/meta-agent/runner";

// ---------------------------------------------------------------------------
// Suspend / resume (T2, D17): the runner pauses before a destructive tool and
// resumes from serialized conversation state once a human decides.
// ---------------------------------------------------------------------------

/** LLM stub returning queued responses, one per call. */
function makeLLM(
  responses: Array<{
    content: string | null;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    finish_reason?: string;
  }>,
): { llm: LLMClient; create: ReturnType<typeof vi.fn> } {
  let i = 0;
  const create = vi.fn().mockImplementation(async () => {
    const res = responses[i] ?? responses[responses.length - 1];
    i++;
    return {
      choices: [
        {
          message: { content: res.content, tool_calls: res.tool_calls },
          finish_reason: res.finish_reason ?? (res.tool_calls ? "tool_calls" : "stop"),
        },
      ],
    };
  });
  return { llm: { chat: { completions: { create } } }, create };
}

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    archetype: "ops",
    tools: [],
    initialPrompt: "Do work.",
    teamId: "team-1",
    agentId: "agent-1",
    peers: [{ id: "agent-2", name: "peer", role: "helper" }],
    a2ax: {
      sendDirect: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn().mockResolvedValue(undefined),
    },
    llm: makeLLM([{ content: "ok" }]).llm,
    // Treat write_file / run_command as destructive for these tests.
    isDestructive: (name) => name === "write_file" || name === "run_command",
    ...overrides,
  };
}

function destructiveCall(id: string, name: string, args: object) {
  return {
    content: null,
    tool_calls: [{ id, function: { name, arguments: JSON.stringify(args) } }],
    finish_reason: "tool_calls",
  };
}

describe("runAgent — suspend on destructive tool", () => {
  it("suspends instead of executing a destructive tool", async () => {
    const a2ax = {
      sendDirect: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn().mockResolvedValue(undefined),
    };
    const { llm } = makeLLM([
      destructiveCall("call_w", "write_file", { path: "x.txt", content: "hi" }),
    ]);

    const result = await runAgent(makeConfig({ a2ax, llm }));

    expect(result.actionType).toBe("suspended");
    expect(result.suspension).toBeDefined();
    expect(result.suspension?.pending).toEqual([
      { id: "call_w", name: "write_file", arguments: JSON.stringify({ path: "x.txt", content: "hi" }) },
    ]);
    // Nothing executed: a2ax untouched, no actions yet.
    expect(a2ax.sendDirect).not.toHaveBeenCalled();
    expect(result.suspension?.actions).toEqual([]);
  });

  it("runs safe tools inline but suspends when a destructive call appears later", async () => {
    const a2ax = {
      sendDirect: vi.fn().mockResolvedValue(undefined),
      broadcast: vi.fn().mockResolvedValue(undefined),
    };
    const { llm } = makeLLM([
      // round 0: a safe broadcast (executes inline)
      {
        content: null,
        tool_calls: [
          { id: "c1", function: { name: "broadcast", arguments: JSON.stringify({ content: "hello" }) } },
        ],
        finish_reason: "tool_calls",
      },
      // round 1: a destructive write (suspends)
      destructiveCall("c2", "write_file", { path: "y.txt", content: "z" }),
    ]);

    const result = await runAgent(makeConfig({ a2ax, llm }));

    expect(a2ax.broadcast).toHaveBeenCalledWith("team-1", "agent-1", "hello");
    expect(result.actionType).toBe("suspended");
    // The earlier safe action is preserved in the suspension for the resume.
    expect(result.suspension?.actions).toHaveLength(1);
    expect(result.suspension?.actions[0].actionType).toBe("broadcast_sent");
    expect(result.suspension?.round).toBe(1);
  });

  it("does not suspend when no classifier is provided (pre-T2 behavior)", async () => {
    // Without isDestructive, every tool runs inline. A 'write_file' here would
    // fall through to executeTool and come back as an unknown-tool error, but
    // crucially the run COMPLETES rather than suspending.
    const { llm } = makeLLM([
      destructiveCall("c1", "report_action", { action_type: "t", summary: "s" }),
      { content: "done" },
    ]);
    const result = await runAgent(makeConfig({ llm, isDestructive: undefined }));
    expect(result.actionType).not.toBe("suspended");
    expect(result.suspension).toBeUndefined();
  });
});

describe("runAgent — resume after decision", () => {
  function suspensionFixture(): AgentSuspension {
    // A conversation suspended on a write_file call.
    return {
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "tick" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_w",
              type: "function",
              function: { name: "write_file", arguments: JSON.stringify({ path: "x.txt", content: "hi" }) },
            },
          ],
        },
      ],
      pending: [
        { id: "call_w", name: "write_file", arguments: JSON.stringify({ path: "x.txt", content: "hi" }) },
      ],
      actions: [],
      round: 0,
    };
  }

  it("executes the tool on approval, then completes from the next LLM turn", async () => {
    // After the approved tool runs, the LLM is asked again and finishes.
    const { llm, create } = makeLLM([{ content: "all done", finish_reason: "stop" }]);

    // write_file isn't a registry tool in the library default registry, so
    // executeTool returns an "unknown tool" result — but the point of this test
    // is the resume MECHANICS: the decision is applied and the loop continues.
    const result = await runAgent(
      makeConfig({
        llm,
        resume: {
          suspension: suspensionFixture(),
          decisions: [{ id: "call_w", approved: true }],
        },
      }),
    );

    // The LLM was called once more after applying the decision.
    expect(create).toHaveBeenCalledTimes(1);
    // The message list handed to the LLM includes a tool result for call_w.
    const sentMessages = create.mock.calls[0][0].messages as Array<Record<string, unknown>>;
    const toolMsg = sentMessages.find(
      (m) => m.role === "tool" && m.tool_call_id === "call_w",
    );
    expect(toolMsg).toBeDefined();
    expect(result.actionType).not.toBe("suspended");
  });

  it("feeds a rejection note to the LLM when the action is rejected", async () => {
    const { llm, create } = makeLLM([{ content: "ok, skipping", finish_reason: "stop" }]);

    const result = await runAgent(
      makeConfig({
        llm,
        resume: {
          suspension: suspensionFixture(),
          decisions: [{ id: "call_w", approved: false, note: "too risky" }],
        },
      }),
    );

    const sentMessages = create.mock.calls[0][0].messages as Array<Record<string, unknown>>;
    const toolMsg = sentMessages.find(
      (m) => m.role === "tool" && m.tool_call_id === "call_w",
    );
    expect(toolMsg).toBeDefined();
    expect(String(toolMsg?.content)).toContain("not approved");
    expect(String(toolMsg?.content)).toContain("too risky");
    expect(result.actionType).not.toBe("suspended");
  });

  it("treats a missing decision as a rejection (fail safe)", async () => {
    const { llm, create } = makeLLM([{ content: "ok", finish_reason: "stop" }]);

    await runAgent(
      makeConfig({
        llm,
        resume: {
          suspension: suspensionFixture(),
          decisions: [], // no decision for call_w
        },
      }),
    );

    const sentMessages = create.mock.calls[0][0].messages as Array<Record<string, unknown>>;
    const toolMsg = sentMessages.find(
      (m) => m.role === "tool" && m.tool_call_id === "call_w",
    );
    expect(String(toolMsg?.content)).toContain("not approved");
  });

  it("can suspend AGAIN if the post-resume turn asks for another destructive tool", async () => {
    // After approving the first write, the LLM immediately asks for a second
    // destructive tool — the runner must suspend a second time.
    const { llm } = makeLLM([
      destructiveCall("call_2", "run_command", { command: "git", args: ["push"] }),
    ]);

    const result = await runAgent(
      makeConfig({
        llm,
        resume: {
          suspension: suspensionFixture(),
          decisions: [{ id: "call_w", approved: true }],
        },
      }),
    );

    expect(result.actionType).toBe("suspended");
    expect(result.suspension?.pending[0].name).toBe("run_command");
  });

  it("round-trips the suspension through JSON unchanged", () => {
    const s = suspensionFixture();
    const roundTripped = JSON.parse(JSON.stringify(s)) as AgentSuspension;
    expect(roundTripped).toEqual(s);
  });
});
