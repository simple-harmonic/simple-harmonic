"use client";

import { useCallback, useEffect, useState } from "react";

interface SafeConfig {
  databaseUrl: string;
  hasDatabase: boolean;
}

type TestStatus = "idle" | "testing" | "ok" | "error";

interface TestResult {
  status: TestStatus;
  message?: string;
}

type SetupPhase = "idle" | "running" | "done" | "error";

export default function DatabaseSettingsPage() {
  const [config, setConfig] = useState<SafeConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const [dbUrl, setDbUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [dbTest, setDbTest] = useState<TestResult>({ status: "idle" });

  const [setupPhase, setSetupPhase] = useState<SetupPhase>("idle");
  const [setupSteps, setSetupSteps] = useState<string[]>([]);
  const [setupError, setSetupError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((cfg: SafeConfig) => {
        setConfig(cfg);
        setDbUrl(cfg.databaseUrl);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    if (!dbUrl) {
      setSaving(false);
      return;
    }

    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ databaseUrl: dbUrl }),
    });
    if (res.ok) {
      const data = await res.json();
      setConfig(data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setSaving(false);
  }, [dbUrl]);

  const testDb = useCallback(async () => {
    setDbTest({ status: "testing" });
    try {
      const res = await fetch("/api/settings/test-db", { method: "POST" });
      const data = await res.json();
      setDbTest(data.ok ? { status: "ok" } : { status: "error", message: data.error });
    } catch {
      setDbTest({ status: "error", message: "Request failed" });
    }
  }, []);

  const handleSetup = useCallback(async () => {
    setSetupPhase("running");
    setSetupSteps([]);
    setSetupError(null);

    try {
      const res = await fetch("/api/settings/setup-db", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ databaseUrl: dbUrl }),
      });
      const data = await res.json();
      setSetupSteps(data.steps || []);

      if (data.ok) {
        setSetupPhase("done");
        const cfg = await fetch("/api/settings").then((r) => r.json());
        setConfig(cfg);
        setDbUrl(cfg.databaseUrl);
      } else {
        setSetupPhase("error");
        setSetupError(data.error || "Setup failed");
      }
    } catch {
      setSetupPhase("error");
      setSetupError("Request failed");
    }
  }, [dbUrl]);

  if (loading || !config) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <span className="text-fg-faint text-sm font-mono">loading...</span>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[640px] mx-auto px-6 py-10">
        <div className="flex items-center gap-3 mb-6">
          <a href="/settings" className="text-[13px] text-brand font-medium">
            &#8592;
          </a>
          <h1 className="text-lg font-semibold tracking-tight">Database</h1>
        </div>

        <div className="flex flex-col gap-8">
          <section>
            <p className="text-[11px] text-fg-faint font-mono mb-4">local PostgreSQL</p>
          </section>

          {/* One-click setup */}
          <section className="border border-border bg-bg-elev rounded-[10px] px-5 py-4">
            <div className="flex items-center gap-3 mb-3">
              <span
                className={`w-2 h-2 rounded-full inline-block ${
                  setupPhase === "done"
                    ? "bg-running"
                    : setupPhase === "error"
                      ? "bg-error"
                      : setupPhase === "running"
                        ? "bg-brand animate-pulse"
                        : "bg-fg-faint"
                }`}
              />
              <span className="text-[13px] font-medium text-fg">Quick Setup</span>
            </div>
            <p className="text-[13px] text-fg-faint leading-relaxed mb-4">
              Creates the database and pushes the schema in one step. Requires a running PostgreSQL
              instance on the target host.
            </p>

            <div className="mb-4">
              <div className="flex items-baseline gap-2 mb-1.5">
                <span className="text-[13px] font-medium text-fg">Connection URL</span>
              </div>
              <input
                type="text"
                value={dbUrl}
                onChange={(e) => setDbUrl(e.target.value)}
                placeholder="postgresql://localhost:5432/simple_harmonic"
                className="w-full bg-bg-input border border-border rounded-md px-3 py-2.5 text-sm text-fg placeholder:text-fg-faint outline-none focus:border-brand font-mono text-[13px]"
              />
            </div>

            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={handleSetup}
                disabled={setupPhase === "running" || !dbUrl}
                className="bg-brand text-white py-[9px] px-4 rounded-md text-[13px] font-medium cursor-pointer disabled:opacity-60"
              >
                {setupPhase === "running" ? "Setting up..." : "Create & Configure"}
              </button>
              <button
                type="button"
                onClick={testDb}
                disabled={dbTest.status === "testing"}
                className="border border-border text-fg-muted py-[7px] px-3.5 rounded-[5px] text-[13px] font-medium cursor-pointer hover:border-border-strong disabled:opacity-60"
              >
                {dbTest.status === "testing" ? "Testing..." : "Test Connection"}
              </button>
              {dbTest.status === "ok" && (
                <span className="text-[13px] text-running font-mono">connected</span>
              )}
              {dbTest.status === "error" && (
                <span className="text-[13px] text-error font-mono">{dbTest.message}</span>
              )}
            </div>

            {setupSteps.length > 0 && (
              <div className="mt-4 border-t border-border pt-3">
                <div className="flex flex-col gap-1">
                  {setupSteps.map((step) => (
                    <div key={step} className="flex items-start gap-2 text-[12px] font-mono">
                      <span className="text-running shrink-0 mt-px">&#10003;</span>
                      <span className="text-fg-muted">{step}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {setupPhase === "done" && (
              <div className="mt-3 text-[13px] text-running font-mono font-medium">
                Database ready.
              </div>
            )}

            {setupError && (
              <div className="mt-3 text-[13px] text-error font-mono">{setupError}</div>
            )}
          </section>

          {/* Manual config */}
          <section>
            <h2 className="text-[11px] text-fg-faint font-semibold tracking-[0.06em] uppercase font-mono mb-4">
              Manual Configuration
            </h2>

            <div className="flex items-baseline gap-2 mb-1.5">
              <span className="text-[13px] font-medium text-fg">Connection URL</span>
              {config.hasDatabase && (
                <span className="text-[11px] text-fg-faint font-mono">
                  Current: {config.databaseUrl}
                </span>
              )}
            </div>
            <input
              type="text"
              value={dbUrl}
              onChange={(e) => setDbUrl(e.target.value)}
              placeholder="postgresql://localhost:5432/simple_harmonic"
              className="w-full bg-bg-input border border-border rounded-md px-3 py-2.5 text-sm text-fg placeholder:text-fg-faint outline-none focus:border-brand font-mono text-[13px]"
            />

            <div className="flex items-center gap-4 mt-4">
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="bg-brand text-white py-[11px] px-[22px] rounded-md text-[15px] font-medium cursor-pointer disabled:opacity-60"
              >
                {saving ? "Saving..." : "Save URL"}
              </button>
              {saved && <span className="text-[13px] text-running font-mono">saved</span>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
