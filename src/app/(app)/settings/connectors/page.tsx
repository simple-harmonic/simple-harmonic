"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

interface Connector {
  id: string;
  name: string;
  description: string;
  configured: boolean;
  maskedValue?: string;
  envVar: string;
}

export default function ConnectorsPage() {
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/settings/connectors")
      .then((r) => r.json())
      .then((data) => {
        setConnectors(data.connectors);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center h-full">
        <span className="text-fg-faint text-sm font-mono">loading...</span>
      </div>
    );
  }

  const configured = connectors.filter((c) => c.configured);
  const missing = connectors.filter((c) => !c.configured);

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
          <span className="text-fg text-[12px] font-mono">Connectors</span>
        </div>
        <h1 className="text-lg font-semibold tracking-tight mb-2">Connectors</h1>
        <p className="text-[13px] text-fg-muted mb-8">
          Credentials and configuration that agent tools need to operate. Set these as environment
          variables in{" "}
          <code className="text-[12px] font-mono bg-bg-elev px-1 py-0.5 rounded">.env.local</code>.
        </p>

        {missing.length > 0 && (
          <section className="mb-8">
            <h2 className="text-[11px] text-paused font-semibold tracking-[0.06em] uppercase font-mono mb-3">
              Not configured
            </h2>
            <div className="flex flex-col gap-3">
              {missing.map((c) => (
                <ConnectorCard key={c.id} connector={c} />
              ))}
            </div>
          </section>
        )}

        {configured.length > 0 && (
          <section>
            <h2 className="text-[11px] text-running font-semibold tracking-[0.06em] uppercase font-mono mb-3">
              Active
            </h2>
            <div className="flex flex-col gap-3">
              {configured.map((c) => (
                <ConnectorCard key={c.id} connector={c} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function ConnectorCard({ connector }: { connector: Connector }) {
  return (
    <div className="border border-border bg-bg-elev rounded-[10px] px-5 py-4">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <span
            className={`w-2 h-2 rounded-full inline-block shrink-0 ${
              connector.configured ? "bg-running" : "bg-paused"
            }`}
          />
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-fg">{connector.name}</div>
            <div className="text-[11px] text-fg-faint font-mono mt-0.5 truncate">
              {connector.maskedValue ?? "not set"}
            </div>
          </div>
        </div>
        <code className="text-[10px] font-mono text-fg-faint bg-bg px-1.5 py-0.5 rounded shrink-0 ml-3">
          {connector.envVar}
        </code>
      </div>
      <p className="text-[12px] text-fg-muted mt-3 leading-relaxed">{connector.description}</p>
    </div>
  );
}
