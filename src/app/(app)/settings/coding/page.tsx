"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type CodingBackend = "codex" | "claude-code" | "opencode";

interface Connector {
  name: string;
  envVar: string;
  configured: boolean;
  value?: string;
}

interface BackendStatus {
  installed: boolean;
  version: string | null;
  authenticated: boolean;
  account?: string;
  plan?: string;
  connectors: Connector[];
}

interface BackendConfig {
  model?: string;
  timeout?: number;
}

interface CodingData {
  current: CodingBackend;
  codingConfig: Record<CodingBackend, BackendConfig>;
  backends: Record<CodingBackend, BackendStatus>;
}

const BACKENDS: Array<{
  value: CodingBackend;
  label: string;
  cli: string;
  desc: string;
}> = [
  {
    value: "codex",
    label: "Codex",
    cli: "codex",
    desc: "OpenAI Codex CLI. Uses your ChatGPT subscription via OAuth.",
  },
  {
    value: "claude-code",
    label: "Claude Code",
    cli: "claude",
    desc: "Anthropic Claude Code CLI. Uses your Anthropic API key.",
  },
  {
    value: "opencode",
    label: "OpenCode",
    cli: "opencode",
    desc: "Open-source coding agent. Bring your own model and provider.",
  },
];

export default function CodingSettingsPage() {
  const [data, setData] = useState<CodingData | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CodingBackend>("codex");
  const [configs, setConfigs] = useState<Record<CodingBackend, BackendConfig>>({
    codex: {},
    "claude-code": {},
    opencode: {},
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings/coding")
      .then((r) => r.json())
      .then((d: CodingData) => {
        setData(d);
        setSelected(d.current);
        setConfigs(d.codingConfig);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        codingBackend: selected,
        codingConfig: configs,
      }),
    });
    if (res.ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      const refreshed = await fetch("/api/settings/coding").then((r) => r.json());
      setData(refreshed);
    }
    setSaving(false);
  }, [selected, configs]);

  const updateBackendConfig = useCallback(
    (backend: CodingBackend, field: keyof BackendConfig, value: string) => {
      setConfigs((prev) => ({
        ...prev,
        [backend]: {
          ...prev[backend],
          [field]: field === "timeout" ? (value ? Number(value) : undefined) : value || undefined,
        },
      }));
    },
    [],
  );

  if (loading || !data) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <span className="text-fg-faint text-sm font-mono">loading...</span>
      </div>
    );
  }

  const dirty =
    selected !== data.current ||
    JSON.stringify(configs) !== JSON.stringify(data.codingConfig);

  const activeBackend = data.backends[selected];
  const activeInfo = BACKENDS.find((b) => b.value === selected)!;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[640px] mx-auto px-6 py-10">
        <div className="flex items-center gap-2 mb-1">
          <Link
            href="/settings"
            className="text-fg-faint hover:text-fg-muted text-[12px] font-mono transition-colors"
          >
            Settings
          </Link>
          <span className="text-fg-faint text-[12px] font-mono">/</span>
          <span className="text-fg text-[12px] font-mono">Coding Agent</span>
        </div>
        <h1 className="text-lg font-semibold tracking-tight mb-2">Coding Agent</h1>
        <p className="text-[13px] text-fg-muted mb-8">
          Choose and configure the CLI backend that powers the{" "}
          <code className="text-[12px] bg-bg-input px-1.5 py-0.5 rounded font-mono">
            coding_task
          </code>{" "}
          tool. Engineering agents use this for multi-file changes, debugging,
          test runs, and research.
        </p>

        {/* Backend selector */}
        <section className="mb-8">
          <h2 className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono mb-3">
            Backend
          </h2>
          <div className="flex flex-col gap-3">
            {BACKENDS.map((b) => {
              const active = selected === b.value;
              const status = data.backends[b.value];
              return (
                <button
                  key={b.value}
                  type="button"
                  onClick={() => setSelected(b.value)}
                  className={`flex items-start gap-4 px-5 py-4 rounded-[10px] border text-left transition-colors cursor-pointer ${
                    active
                      ? "border-brand bg-brand/5"
                      : "border-border bg-bg-elev hover:border-border-strong"
                  }`}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`text-[13px] font-medium ${active ? "text-brand" : "text-fg"}`}
                      >
                        {b.label}
                      </span>
                      {status.installed ? (
                        <span className="text-[10px] bg-running/15 text-running px-1.5 py-0.5 rounded font-mono">
                          {status.version || "installed"}
                        </span>
                      ) : (
                        <span className="text-[10px] bg-paused/15 text-paused px-1.5 py-0.5 rounded font-mono">
                          not found
                        </span>
                      )}
                    </div>
                    <div className="text-[12px] text-fg-faint mt-1">{b.desc}</div>
                  </div>
                  <div className="pt-1">
                    <span
                      className={`w-4 h-4 rounded-full border-2 inline-block ${
                        active ? "border-brand bg-brand" : "border-border"
                      }`}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Connectors for selected backend */}
        <section className="mb-8">
          <h2 className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono mb-3">
            Connectors
            <span className="ml-2 text-fg-faint font-normal normal-case">
              for {activeInfo.label}
            </span>
          </h2>
          {!activeBackend.installed && (
            <div className="border border-paused/30 bg-paused/5 rounded-[10px] px-5 py-4 mb-3">
              <div className="flex items-center gap-2 mb-1">
                <span className="w-2 h-2 rounded-full bg-paused inline-block" />
                <span className="text-[13px] font-medium text-fg">CLI not installed</span>
              </div>
              <p className="text-[12px] text-fg-muted leading-relaxed">
                Install the <code className="font-mono text-[11px] bg-bg-input px-1 py-0.5 rounded">{activeInfo.cli}</code> CLI
                and make sure it is on your PATH.
              </p>
            </div>
          )}
          <div className="flex flex-col gap-3">
            {activeBackend.connectors.map((c) => (
              <div
                key={c.envVar}
                className="border border-border bg-bg-elev rounded-[10px] px-5 py-4"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-3 min-w-0">
                    <span
                      className={`w-2 h-2 rounded-full inline-block shrink-0 ${
                        c.configured ? "bg-running" : "bg-paused"
                      }`}
                    />
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium text-fg">{c.name}</div>
                      <div className="text-[11px] text-fg-faint font-mono mt-0.5 truncate">
                        {c.value ?? "not set"}
                      </div>
                    </div>
                  </div>
                  <code className="text-[10px] font-mono text-fg-faint bg-bg px-1.5 py-0.5 rounded shrink-0 ml-3">
                    {c.envVar}
                  </code>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Per-backend configuration */}
        <section className="mb-8">
          <h2 className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono mb-3">
            Configuration
            <span className="ml-2 text-fg-faint font-normal normal-case">
              for {activeInfo.label}
            </span>
          </h2>
          <div className="border border-border bg-bg-elev rounded-[10px] px-5 py-5">
            <div className="flex flex-col gap-5">
              <FieldGroup
                label="Model override"
                hint="Leave empty to use the CLI default"
              >
                <input
                  type="text"
                  value={configs[selected]?.model || ""}
                  onChange={(e) =>
                    updateBackendConfig(selected, "model", e.target.value)
                  }
                  placeholder={
                    selected === "codex"
                      ? "e.g. o3, gpt-4.1"
                      : selected === "claude-code"
                        ? "e.g. sonnet, opus"
                        : "e.g. anthropic/claude-sonnet-4-20250514"
                  }
                  className="w-full bg-bg-input border border-border rounded-md px-3 py-2.5 text-sm text-fg placeholder:text-fg-faint outline-none focus:border-brand font-mono text-[13px]"
                />
              </FieldGroup>
              <FieldGroup
                label="Timeout"
                hint="seconds, default 300"
              >
                <input
                  type="number"
                  min={30}
                  max={1800}
                  value={configs[selected]?.timeout || ""}
                  onChange={(e) =>
                    updateBackendConfig(selected, "timeout", e.target.value)
                  }
                  placeholder="300"
                  className="w-32 bg-bg-input border border-border rounded-md px-3 py-2.5 text-sm text-fg placeholder:text-fg-faint outline-none focus:border-brand font-mono text-[13px]"
                />
              </FieldGroup>
            </div>
          </div>
        </section>

        {/* Save */}
        <div className="flex items-center gap-4 pt-4 border-t border-border">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !dirty}
            className="bg-brand text-white py-[11px] px-[22px] rounded-md text-[15px] font-medium cursor-pointer disabled:opacity-60"
          >
            {saving ? "Saving..." : "Save"}
          </button>
          {saved && (
            <span className="text-[13px] text-running font-mono">saved</span>
          )}
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
        {hint && (
          <span className="text-[11px] text-fg-faint font-mono">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}
