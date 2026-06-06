"use client";

import { useCallback, useEffect, useState } from "react";

interface InfraEvent {
  id: string;
  level: string;
  severity: string;
  source: string;
  message: string;
  agentId: string | null;
  teamId: string | null;
  createdAt: string;
}

interface InfraReport {
  events: InfraEvent[];
  total: number;
  infraCount: number;
  toolCount: number;
}

interface PlatformStatusData {
  status: "healthy" | "degraded" | "maintenance";
  message: string | null;
}

export default function PlatformPage() {
  const [report, setReport] = useState<InfraReport | null>(null);
  const [platformStatus, setPlatformStatus] = useState<PlatformStatusData | null>(null);
  const [loading, setLoading] = useState(true);
  const [statusSaving, setStatusSaving] = useState(false);
  const [acknowledging, setAcknowledging] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    try {
      const [reportRes, statusRes] = await Promise.all([
        fetch("/api/infra-report").then((r) => r.json()),
        fetch("/api/settings/platform-status").then((r) => r.json()),
      ]);
      setReport(reportRes);
      setPlatformStatus(statusRes);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const setStatus = async (status: string, message?: string) => {
    setStatusSaving(true);
    try {
      await fetch("/api/settings/platform-status", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, message }),
      });
      setPlatformStatus({
        status: status as PlatformStatusData["status"],
        message: message ?? null,
      });
    } catch {
      // silent
    } finally {
      setStatusSaving(false);
    }
  };

  const acknowledgeEvent = async (id: string) => {
    setAcknowledging((prev) => new Set([...prev, id]));
    try {
      await fetch("/api/infra-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventIds: [id] }),
      });
      setReport((prev) =>
        prev
          ? { ...prev, events: prev.events.filter((e) => e.id !== id), total: prev.total - 1 }
          : prev,
      );
    } catch {
      // silent
    } finally {
      setAcknowledging((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  };

  const acknowledgeAll = async () => {
    if (!report) return;
    const ids = report.events.map((e) => e.id);
    setAcknowledging(new Set(ids));
    try {
      await fetch("/api/infra-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventIds: ids }),
      });
      setReport({ events: [], total: 0, infraCount: 0, toolCount: 0 });
    } catch {
      // silent
    } finally {
      setAcknowledging(new Set());
    }
  };

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <span className="text-fg-faint text-sm font-mono">loading...</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[640px] mx-auto px-6 py-10">
        <h1 className="text-lg font-semibold tracking-tight mb-6">Platform Health</h1>

        {/* Platform Status */}
        <section className="mb-10">
          <h2 className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono mb-4">
            Platform Status
          </h2>
          <div className="border border-border bg-bg-elev rounded-[10px] p-5">
            <div className="flex items-center gap-2 mb-4">
              <StatusDot status={platformStatus?.status ?? "healthy"} />
              <span className="text-[13px] font-medium text-fg capitalize">
                {platformStatus?.status ?? "healthy"}
              </span>
              {platformStatus?.message && (
                <span className="text-[11px] text-fg-faint font-mono ml-2">
                  {platformStatus.message}
                </span>
              )}
            </div>
            <p className="text-[11px] text-fg-faint font-mono mb-4">
              When set to degraded or maintenance, all agents are told to reduce non-essential work.
            </p>
            <div className="flex gap-2">
              {(["healthy", "degraded", "maintenance"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={statusSaving}
                  onClick={() => setStatus(s)}
                  className={`px-3 py-1.5 rounded-md text-[12px] font-medium transition-colors cursor-pointer ${
                    platformStatus?.status === s
                      ? "bg-brand text-bg"
                      : "border border-border text-fg-muted hover:border-border-strong"
                  }`}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Infrastructure Report */}
        <section className="mb-10">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono">
              Infrastructure Report
            </h2>
            {report && report.events.length > 0 && (
              <button
                type="button"
                onClick={acknowledgeAll}
                className="text-[11px] text-fg-faint hover:text-fg font-mono transition-colors cursor-pointer"
              >
                Dismiss all
              </button>
            )}
          </div>

          {report && report.events.length > 0 ? (
            <div className="flex flex-col gap-2">
              <div className="text-[11px] text-fg-faint font-mono mb-2">
                {report.infraCount} infra, {report.toolCount} tool ({report.total} total
                unacknowledged)
              </div>
              {report.events.map((event) => (
                <div
                  key={event.id}
                  className="border border-border bg-bg-elev rounded-[10px] px-4 py-3 flex items-start justify-between gap-3"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <SeverityBadge severity={event.severity} />
                      <LevelBadge level={event.level} />
                      <span className="text-[11px] text-fg-faint font-mono">{event.source}</span>
                      <span className="text-[11px] text-fg-faint font-mono">
                        {new Date(event.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <div className="text-[13px] text-fg font-mono break-words">{event.message}</div>
                  </div>
                  <button
                    type="button"
                    disabled={acknowledging.has(event.id)}
                    onClick={() => acknowledgeEvent(event.id)}
                    className="text-[11px] text-fg-faint hover:text-fg font-mono shrink-0 transition-colors cursor-pointer"
                  >
                    dismiss
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div className="border border-border bg-bg-elev rounded-[10px] p-5 text-center">
              <span className="text-[13px] text-fg-faint font-mono">No unacknowledged events</span>
            </div>
          )}
        </section>

        {/* Telemetry note */}
        <section>
          <h2 className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono mb-4">
            Telemetry
          </h2>
          <div className="border border-border bg-bg-elev rounded-[10px] p-5">
            <p className="text-[13px] text-fg mb-2">
              Tool and infrastructure insights help improve Simple Harmonic. This is controlled
              per-team from the team settings.
            </p>
            <p className="text-[11px] text-fg-faint font-mono">
              Agent and team operational events are always recorded for your agents to function. The
              telemetry toggle only controls whether tool-level and infrastructure-level events are
              collected.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: string }) {
  const color =
    status === "healthy" ? "bg-running" : status === "degraded" ? "bg-paused" : "bg-errored";
  return <span className={`w-2 h-2 rounded-full inline-block ${color}`} />;
}

function SeverityBadge({ severity }: { severity: string }) {
  const color =
    severity === "error"
      ? "text-errored bg-errored/10"
      : severity === "warning"
        ? "text-paused bg-paused/10"
        : "text-fg-faint bg-bg";
  return (
    <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${color}`}>
      {severity.toUpperCase()}
    </span>
  );
}

function LevelBadge({ level }: { level: string }) {
  const color = level === "infra" ? "text-brand bg-brand/10" : "text-fg-muted bg-bg";
  return <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${color}`}>{level}</span>;
}
