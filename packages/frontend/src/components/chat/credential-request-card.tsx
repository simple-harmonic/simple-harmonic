"use client";

import { useState } from "react";

interface CredentialRequestCardProps {
  credentialKey: string;
  label: string;
  reason: string;
  helpUrl: string | null;
  onSubmit: (key: string, value: string) => void;
}

export function CredentialRequestCard({
  credentialKey,
  label,
  reason,
  helpUrl,
  onSubmit,
}: CredentialRequestCardProps) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async () => {
    if (!value.trim()) return;
    setSubmitting(true);
    try {
      const res = await fetch("/api/settings/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: credentialKey, value: value.trim() }),
      });
      if (res.ok) {
        setSubmitted(true);
        onSubmit(credentialKey, value.trim());
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="border border-running/40 bg-running/5 rounded-[10px] px-[22px] py-5">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-running" />
          <span className="text-[13px] font-semibold text-fg">
            {label} configured
          </span>
        </div>
        <p className="text-[12px] text-fg-muted mt-2">
          Encrypted and stored in Apollo. Agents can now use tools that require this credential.
        </p>
      </div>
    );
  }

  return (
    <div className="border-[1.5px] border-brand bg-bg-elev rounded-[10px] px-[22px] py-5">
      <div className="text-[11px] text-brand font-semibold tracking-[0.06em] uppercase font-mono mb-3">
        Credential needed
      </div>

      <div className="text-[15px] font-semibold text-fg">{label}</div>
      <p className="text-[13px] text-fg-muted mt-1">{reason}</p>

      {helpUrl && (
        <a
          href={helpUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-[12px] text-brand underline mt-2"
        >
          Where to get this &rarr;
        </a>
      )}

      <div className="mt-4">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={`Paste your ${label} here`}
          className="w-full bg-bg border border-border rounded-md px-3 py-2.5 text-[13px] font-mono text-fg placeholder:text-fg-faint outline-none focus:border-brand"
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || !value.trim()}
          className="bg-brand text-white py-[9px] px-[18px] rounded-md text-[13px] font-medium cursor-pointer disabled:opacity-60"
        >
          {submitting ? "Saving..." : "Save credential"}
        </button>
      </div>

      <div className="mt-4 flex items-start gap-2 text-[11px] text-fg-faint">
        <svg className="w-3.5 h-3.5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
        <span>
          This credential is encrypted and stored in Apollo, Simple Harmonic's secrets manager. It is <strong className="text-fg-muted">never stored in the database or any file agents can access</strong>. Agents cannot read the raw value directly. They access it indirectly through their tools (e.g., GitHub API calls use the token in headers, but the agent never sees it).
        </span>
      </div>
    </div>
  );
}
