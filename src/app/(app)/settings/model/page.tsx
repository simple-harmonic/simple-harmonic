"use client";

import { useCallback, useEffect, useState } from "react";

interface SafeConfig {
  openaiApiKey: string;
  openaiBaseUrl: string;
  model: string;
  hasOpenaiKey: boolean;
  apiKeySource: "config" | "env" | "codex" | "none";
}

interface CodexModel {
  slug: string;
  displayName: string;
  description: string;
}

interface CodexStatus {
  found: boolean;
  authMode: string | null;
  email: string | null;
  plan: string | null;
  lastRefresh: string | null;
  tokenExpiry: string | null;
  hasAccessToken: boolean;
  models: CodexModel[];
}

type TestStatus = "idle" | "testing" | "ok" | "error";

interface TestResult {
  status: TestStatus;
  message?: string;
}

const FALLBACK_MODELS = [
  { value: "o4-mini", label: "o4-mini", desc: "Fast, cost-effective" },
  { value: "gpt-4o", label: "gpt-4o", desc: "Balanced capability" },
];

export default function ModelSettingsPage() {
  const [config, setConfig] = useState<SafeConfig | null>(null);
  const [codex, setCodex] = useState<CodexStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const [model, setModel] = useState("");
  const [customModel, setCustomModel] = useState("");

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [llmTest, setLlmTest] = useState<TestResult>({ status: "idle" });
  const [refreshing, setRefreshing] = useState(false);
  const [loggingIn, setLoggingIn] = useState(false);
  const [reAuthing, setReAuthing] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch("/api/settings").then((r) => r.json()),
      fetch("/api/settings/codex").then((r) => r.json()),
    ])
      .then(([cfg, cx]: [SafeConfig, CodexStatus]) => {
        setConfig(cfg);
        setCodex(cx);
        setModel(cfg.model);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const modelOptions =
    codex?.models && codex.models.length > 0
      ? codex.models.map((m) => ({ value: m.slug, label: m.slug, desc: m.description }))
      : FALLBACK_MODELS;
  const isKnownModel = modelOptions.some((m) => m.value === model);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    const body: Record<string, string> = {};
    const finalModel = isKnownModel ? model : customModel || model;
    if (finalModel) body.model = finalModel;

    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = await res.json();
      setConfig(data);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
    setSaving(false);
  }, [model, customModel, isKnownModel]);

  const handleRefreshCodex = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/settings/codex", { method: "POST" });
      const data = await res.json();
      if (data.ok) {
        const [cfg, cx] = await Promise.all([
          fetch("/api/settings").then((r) => r.json()),
          fetch("/api/settings/codex").then((r) => r.json()),
        ]);
        setConfig(cfg);
        setCodex(cx);
      }
    } catch {
      // ignore
    }
    setRefreshing(false);
  }, []);

  const handleReAuth = useCallback(async () => {
    if (
      !confirm(
        "Re-authenticate? This signs you out and opens a fresh OAuth flow in your browser.",
      )
    )
      return;
    setReAuthing(true);
    try {
      await fetch("/api/settings/codex-login?force=true", { method: "POST" });
      const poll = setInterval(async () => {
        try {
          const res = await fetch("/api/settings/codex-login");
          const data = await res.json();
          if (data.authenticated) {
            clearInterval(poll);
            setReAuthing(false);
            const [cfg, cx] = await Promise.all([
              fetch("/api/settings").then((r) => r.json()),
              fetch("/api/settings/codex").then((r) => r.json()),
            ]);
            setConfig(cfg);
            setCodex(cx);
          }
        } catch {
          // ignore
        }
      }, 2000);
      setTimeout(() => {
        clearInterval(poll);
        setReAuthing(false);
      }, 180000);
    } catch {
      setReAuthing(false);
    }
  }, []);

  const testLlm = useCallback(async () => {
    setLlmTest({ status: "testing" });
    try {
      const res = await fetch("/api/settings/test-llm", { method: "POST" });
      const data = await res.json();
      setLlmTest(
        data.ok
          ? { status: "ok", message: `${data.model}: ${data.response}` }
          : { status: "error", message: data.error },
      );
    } catch {
      setLlmTest({ status: "error", message: "Request failed" });
    }
  }, []);

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
          <a href="/settings" className="text-[13px] text-brand font-medium">&#8592;</a>
          <h1 className="text-lg font-semibold tracking-tight">LLM Provider</h1>
        </div>

        <div className="flex flex-col gap-10">
          {/* Codex Subscription */}
          {codex && (
            <section>
              <h2 className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono mb-4">
                Codex Subscription
              </h2>
              {codex.found ? (
                <div className="border border-border bg-bg-elev rounded-[10px] px-5 py-4">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="w-2 h-2 rounded-full bg-running inline-block" />
                    <span className="text-[13px] font-medium text-fg">Connected via Codex CLI</span>
                    {config.apiKeySource === "codex" && (
                      <span className="text-[11px] bg-brand-soft text-brand px-2 py-0.5 rounded font-mono">
                        active
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 text-[13px] mb-4">
                    <div className="text-fg-faint">Account</div>
                    <div className="text-fg font-mono">{codex.email || "unknown"}</div>
                    <div className="text-fg-faint">Plan</div>
                    <div className="text-fg font-mono">{codex.plan || "unknown"}</div>
                    <div className="text-fg-faint">Auth mode</div>
                    <div className="text-fg font-mono">{codex.authMode || "unknown"}</div>
                    <div className="text-fg-faint">Token expires</div>
                    <div className="text-fg font-mono">
                      {codex.tokenExpiry
                        ? new Date(codex.tokenExpiry).toLocaleDateString()
                        : "unknown"}
                    </div>
                    <div className="text-fg-faint">Last refresh</div>
                    <div className="text-fg font-mono">
                      {codex.lastRefresh ? new Date(codex.lastRefresh).toLocaleString() : "never"}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-wrap">
                    <button
                      type="button"
                      onClick={handleRefreshCodex}
                      disabled={refreshing || reAuthing}
                      className="border border-border text-fg-muted py-[7px] px-3.5 rounded-[5px] text-[13px] font-medium cursor-pointer hover:border-border-strong disabled:opacity-60"
                    >
                      {refreshing ? "Refreshing..." : "Refresh Token"}
                    </button>
                    <button
                      type="button"
                      onClick={handleReAuth}
                      disabled={refreshing || reAuthing}
                      title="Sign out and start a fresh OAuth flow"
                      className="border border-border text-fg-muted py-[7px] px-3.5 rounded-[5px] text-[13px] font-medium cursor-pointer hover:border-border-strong disabled:opacity-60"
                    >
                      {reAuthing ? "Waiting for sign-in..." : "Re-authenticate"}
                    </button>
                    <span className="text-[11px] text-fg-faint font-mono">~/.codex/auth.json</span>
                  </div>
                  {reAuthing && (
                    <p className="mt-3 text-[11px] text-fg-faint leading-relaxed">
                      Complete sign-in in the browser tab that opened. This page updates
                      automatically.
                    </p>
                  )}
                  {config.apiKeySource === "codex" && (
                    <p className="mt-3 text-[11px] text-fg-faint leading-relaxed">
                      Using your Codex OAuth token as the API key. If you hit quota errors, add
                      Platform API credits at platform.openai.com or paste an API key below to
                      override.
                    </p>
                  )}
                </div>
              ) : (
                <div className="border border-border bg-bg-elev rounded-[10px] px-5 py-4">
                  <div className="flex items-center gap-3 mb-3">
                    <span className="w-2 h-2 rounded-full bg-paused inline-block" />
                    <span className="text-[13px] font-medium text-fg-muted">Not authenticated</span>
                  </div>
                  <p className="text-[13px] text-fg-faint leading-relaxed mb-4">
                    Sign in with your OpenAI account to use your Codex subscription.
                  </p>
                  <button
                    type="button"
                    onClick={async () => {
                      setLoggingIn(true);
                      try {
                        await fetch("/api/settings/codex-login", { method: "POST" });
                        const poll = setInterval(async () => {
                          try {
                            const res = await fetch("/api/settings/codex-login");
                            const data = await res.json();
                            if (data.authenticated) {
                              clearInterval(poll);
                              setLoggingIn(false);
                              const [cfg, cx] = await Promise.all([
                                fetch("/api/settings").then((r) => r.json()),
                                fetch("/api/settings/codex").then((r) => r.json()),
                              ]);
                              setConfig(cfg);
                              setCodex(cx);
                            }
                          } catch {
                            // ignore
                          }
                        }, 2000);
                        setTimeout(() => {
                          clearInterval(poll);
                          setLoggingIn(false);
                        }, 180000);
                      } catch {
                        setLoggingIn(false);
                      }
                    }}
                    disabled={loggingIn}
                    className="bg-brand text-white py-[9px] px-4 rounded-md text-[13px] font-medium cursor-pointer disabled:opacity-60"
                  >
                    {loggingIn ? "Waiting for sign-in..." : "Sign in with OpenAI"}
                  </button>
                  {loggingIn && (
                    <p className="mt-3 text-[11px] text-fg-faint leading-relaxed">
                      Complete sign-in in the browser tab that opened. This page updates
                      automatically.
                    </p>
                  )}
                </div>
              )}
            </section>
          )}

          {/* LLM Configuration */}
          <section>
            <h2 className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono mb-4">
              LLM Provider
              {config.apiKeySource !== "none" && (
                <span className="ml-2 text-fg-faint font-normal normal-case">
                  · using{" "}
                  {config.apiKeySource === "codex"
                    ? "Codex token"
                    : config.apiKeySource === "env"
                      ? "env var"
                      : "saved key"}
                </span>
              )}
            </h2>

            <div className="flex flex-col gap-6">
              <FieldGroup label="Model">
                <div className="grid grid-cols-3 gap-2">
                  {modelOptions.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => {
                        setModel(opt.value);
                        setCustomModel("");
                      }}
                      className={`px-3 py-2 rounded-md text-left border cursor-pointer transition-colors ${
                        model === opt.value
                          ? "border-brand bg-brand-soft text-fg"
                          : "border-border bg-bg-input text-fg-muted hover:border-border-strong"
                      }`}
                    >
                      <div className="text-[13px] font-medium">{opt.label}</div>
                      <div className="text-[11px] text-fg-faint mt-0.5">{opt.desc}</div>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setModel("custom")}
                    className={`px-3 py-2 rounded-md text-left border cursor-pointer transition-colors ${
                      !isKnownModel
                        ? "border-brand bg-brand-soft text-fg"
                        : "border-border bg-bg-input text-fg-muted hover:border-border-strong"
                    }`}
                  >
                    <div className="text-[13px] font-medium">Custom</div>
                    <div className="text-[11px] text-fg-faint mt-0.5">Any model ID</div>
                  </button>
                </div>
                {!isKnownModel && (
                  <input
                    type="text"
                    value={customModel || (model !== "custom" ? model : "")}
                    onChange={(e) => {
                      setCustomModel(e.target.value);
                      setModel("custom");
                    }}
                    placeholder="e.g. ft:gpt-4o:my-org:custom:id"
                    className="mt-2 w-full bg-bg-input border border-border rounded-md px-3 py-2.5 text-sm text-fg placeholder:text-fg-faint outline-none focus:border-brand font-mono text-[13px]"
                  />
                )}
              </FieldGroup>

              <div className="flex items-center gap-3">
                <TestButton status={llmTest.status} onClick={testLlm} label="Test LLM" />
                <TestStatusBadge result={llmTest} />
              </div>
            </div>
          </section>

          {/* Save */}
          <div className="flex items-center gap-4 pt-4 border-t border-border">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="bg-brand text-white py-[11px] px-[22px] rounded-md text-[15px] font-medium cursor-pointer disabled:opacity-60"
            >
              {saving ? "Saving..." : "Save"}
            </button>
            {saved && <span className="text-[13px] text-running font-mono">saved</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

function FieldGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="flex items-baseline gap-2 mb-1.5">
        <span className="text-[13px] font-medium text-fg">{label}</span>
        {hint && <span className="text-[11px] text-fg-faint font-mono">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function TestButton({
  status,
  onClick,
  label,
}: {
  status: TestStatus;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={status === "testing"}
      className="border border-border text-fg-muted py-[7px] px-3.5 rounded-[5px] text-[13px] font-medium cursor-pointer hover:border-border-strong disabled:opacity-60"
    >
      {status === "testing" ? "Testing..." : label}
    </button>
  );
}

function TestStatusBadge({ result }: { result: TestResult }) {
  if (result.status === "idle" || result.status === "testing") return null;
  if (result.status === "ok") {
    return (
      <span className="text-[13px] text-running font-mono">
        connected {result.message ? `· ${result.message}` : ""}
      </span>
    );
  }
  return <span className="text-[13px] text-error font-mono">{result.message || "failed"}</span>;
}
