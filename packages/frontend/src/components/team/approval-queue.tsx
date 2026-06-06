"use client";

// ---------------------------------------------------------------------------
// Approval queue (T2, part 3b)
//
// Lists destructive tool calls an agent has parked awaiting human sign-off and
// lets the user approve or reject each one. Self-contained: polls
// GET /api/team/[id]/approvals on an interval and POSTs decisions back. The
// next tick consumes the resolved rows and resumes the agent.
// ---------------------------------------------------------------------------

import { useCallback, useEffect, useState } from "react";

interface ApprovalItem {
  id: string;
  agentId: string;
  toolName: string;
  toolArguments: string;
  createdAt: string;
}

interface ApprovalQueueProps {
  teamId: string;
  /** Map agentId -> display name so cards can name the agent. */
  agentNames?: Record<string, string>;
  /** Poll interval; default 4s (the dev tick loop runs every 10s). */
  pollMs?: number;
}

export function ApprovalQueue({ teamId, agentNames = {}, pollMs = 4000 }: ApprovalQueueProps) {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/team/${teamId}/approvals`);
      if (!res.ok) return;
      const data = (await res.json()) as { approvals: ApprovalItem[] };
      setItems(data.approvals);
    } catch {
      // transient; next poll retries
    }
  }, [teamId]);

  useEffect(() => {
    load();
    const t = setInterval(load, pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);

  const decide = useCallback(
    async (approvalId: string, decision: "approved" | "rejected") => {
      setBusyId(approvalId);
      // Optimistically drop the card; reload reconciles if the POST failed.
      setItems((prev) => prev.filter((i) => i.id !== approvalId));
      try {
        const res = await fetch(`/api/team/${teamId}/approvals`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approvalId, decision }),
        });
        if (!res.ok) await load();
      } catch {
        await load();
      } finally {
        setBusyId(null);
      }
    },
    [teamId, load],
  );

  if (items.length === 0) return null;

  return (
    <div className="border-b border-border bg-bg shrink-0">
      <div className="px-4 py-2 text-[11px] font-mono uppercase tracking-wide text-fg-faint">
        Awaiting approval ({items.length})
      </div>
      <div className="flex flex-col gap-2 px-4 pb-3">
        {items.map((item) => (
          <div
            key={item.id}
            className="rounded-md border border-brand/40 bg-brand/5 p-3 text-[13px]"
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-semibold text-fg">
                {agentNames[item.agentId] ?? "An agent"} wants to run{" "}
                <code className="font-mono text-brand">{item.toolName}</code>
              </span>
            </div>
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-bg-subtle p-2 font-mono text-[11px] text-fg-faint">
              {formatArgs(item.toolArguments)}
            </pre>
            <div className="mt-2 flex gap-2">
              <button
                type="button"
                disabled={busyId === item.id}
                onClick={() => decide(item.id, "approved")}
                className="rounded bg-brand px-3 py-1 text-[12px] font-medium text-white disabled:opacity-50"
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busyId === item.id}
                onClick={() => decide(item.id, "rejected")}
                className="rounded border border-border px-3 py-1 text-[12px] font-medium text-fg disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Pretty-print the raw JSON args string; fall back to the raw text. */
function formatArgs(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
