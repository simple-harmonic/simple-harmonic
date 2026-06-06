"use client";

import { type ThemePref, useTheme } from "@simple-harmonic/frontend/components/theme-provider";
import Link from "next/link";
import { useEffect, useState } from "react";

interface SafeConfig {
  model: string;
  databaseUrl: string;
  hasOpenaiKey: boolean;
  hasDatabase: boolean;
  apiKeySource: "config" | "env" | "codex" | "none";
  codingBackend: "codex" | "claude-code" | "opencode";
}

export default function SettingsPage() {
  const [config, setConfig] = useState<SafeConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((cfg: SafeConfig) => {
        setConfig(cfg);
        setLoading(false);
      })
      .catch(() => setLoading(false));
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
        <h1 className="text-lg font-semibold tracking-tight mb-6">Settings</h1>

        <section className="mb-10">
          <h2 className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono mb-4">
            Configuration
          </h2>
          <div className="flex flex-col gap-3">
            <SettingsCard
              href="/settings/model"
              title="LLM Provider"
              subtitle={
                config.apiKeySource !== "none"
                  ? `${config.model} · using ${config.apiKeySource === "codex" ? "Codex token" : config.apiKeySource === "env" ? "env var" : "saved key"}`
                  : "Not configured"
              }
              status={config.apiKeySource !== "none" ? "ok" : "warning"}
            />
            <SettingsCard
              href="/settings/database"
              title="Database"
              subtitle={config.hasDatabase ? config.databaseUrl : "Not configured"}
              status={config.hasDatabase ? "ok" : "warning"}
            />
          </div>
        </section>

        <section className="mb-10">
          <h2 className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono mb-4">
            Agent Tooling
          </h2>
          <div className="flex flex-col gap-3">
            <SettingsCard
              href="/settings/coding"
              title="Coding Agent"
              subtitle={`${config.codingBackend} · autonomous coding, testing, and research`}
              status="ok"
            />
            <SettingsCard
              href="/settings/connectors"
              title="Connectors"
              subtitle="API keys, tokens, and env vars that tools need"
              status="ok"
            />
            <SettingsCard
              href="/settings/skills"
              title="Skills"
              subtitle="Browse tools and manage per-agent assignments"
              status="ok"
            />
          </div>
        </section>

        <section className="mb-10">
          <h2 className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono mb-4">
            Platform
          </h2>
          <div className="flex flex-col gap-3">
            <SettingsCard
              href="/settings/platform"
              title="Platform Health"
              subtitle="Infrastructure report, platform status, telemetry"
              status="ok"
            />
          </div>
        </section>

        <section>
          <h2 className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono mb-4">
            Appearance
          </h2>
          <ThemeCard />
        </section>
      </div>
    </div>
  );
}

function ThemeCard() {
  const { pref, resolved, setPref } = useTheme();

  const options: Array<{ value: ThemePref; label: string; description: string }> = [
    { value: "system", label: "System", description: "Match your OS preference" },
    { value: "light", label: "Light", description: "Always light" },
    { value: "dark", label: "Dark", description: "Always dark" },
  ];

  return (
    <div className="border border-border bg-bg-elev rounded-[10px] p-5">
      <div className="flex items-start justify-between mb-4">
        <div>
          <div className="text-[13px] font-medium text-fg">Theme</div>
          <div className="text-[11px] text-fg-faint font-mono mt-0.5">
            currently · {resolved}
            {pref === "system" && " (system)"}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {options.map((opt) => {
          const active = pref === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => setPref(opt.value)}
              className={`flex flex-col items-start gap-1 px-3 py-2.5 rounded-md border text-left transition-colors cursor-pointer ${
                active
                  ? "border-brand bg-brand/10"
                  : "border-border bg-bg hover:border-border-strong"
              }`}
            >
              <span className={`text-[13px] font-medium ${active ? "text-brand" : "text-fg"}`}>
                {opt.label}
              </span>
              <span className="text-[11px] text-fg-faint font-mono">{opt.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SettingsCard({
  href,
  title,
  subtitle,
  status,
}: {
  href: string;
  title: string;
  subtitle: string;
  status: "ok" | "warning";
}) {
  return (
    <Link
      href={href}
      className="flex items-center justify-between border border-border bg-bg-elev rounded-[10px] px-5 py-4 hover:border-border-strong transition-colors group"
    >
      <div className="flex items-center gap-3 min-w-0">
        <span
          className={`w-2 h-2 rounded-full inline-block shrink-0 ${
            status === "ok" ? "bg-running" : "bg-paused"
          }`}
        />
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-fg">{title}</div>
          <div className="text-[11px] text-fg-faint font-mono truncate">{subtitle}</div>
        </div>
      </div>
      <span className="text-fg-faint group-hover:text-fg-muted transition-colors text-sm">
        &#8594;
      </span>
    </Link>
  );
}
