"use client";

import { useCallback, useEffect, useState } from "react";
import { DEFAULT_META_AGENT_PROMPT } from "@/lib/meta-agent/default-prompt";
import { DEFAULT_COFOUNDER_NAME, resolveCofounderName } from "@/lib/meta-agent/identity";

interface MetaAgentPanelProps {
  teamId: string;
  teamName: string;
  metaAgentPrompt: string | null;
  cofounderName: string | null;
  onClose: () => void;
  onUpdated: (updates: { name: string; metaAgentPrompt: string | null; cofounderName: string | null }) => void;
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-[11px] text-fg-faint font-mono uppercase tracking-wider mb-1.5">
      {children}
    </label>
  );
}

export function MetaAgentPanel({ teamId, teamName, metaAgentPrompt, cofounderName, onClose, onUpdated }: MetaAgentPanelProps) {
  const [name, setName] = useState(teamName);
  const [prompt, setPrompt] = useState(metaAgentPrompt ?? DEFAULT_META_AGENT_PROMPT);
  const [cofounder, setCofounder] = useState(cofounderName ?? "");
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setName(teamName);
    setPrompt(metaAgentPrompt ?? DEFAULT_META_AGENT_PROMPT);
    setCofounder(cofounderName ?? "");
    setDirty(false);
  }, [teamName, metaAgentPrompt, cofounderName]);

  const markDirty = useCallback(<T,>(setter: (v: T) => void) => {
    return (v: T) => { setter(v); setDirty(true); };
  }, []);

  const handleSave = async () => {
    setSaving(true);
    try {
      const cofounderTrimmed = cofounder.trim() || null;
      const res = await fetch(`/api/team/${teamId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          metaAgentPrompt: prompt.trim() || null,
          cofounderName: cofounderTrimmed,
        }),
      });
      if (res.ok) {
        onUpdated({
          name,
          metaAgentPrompt: prompt.trim() || null,
          cofounderName: cofounderTrimmed,
        });
        setDirty(false);
      }
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  const inputClass =
    "w-full bg-bg border border-border rounded px-3 py-2 text-sm text-fg focus:outline-none focus:border-brand transition-colors";

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 bottom-0 w-[480px] bg-bg-elev border-l border-border z-50 flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2.5">
            <span className="text-[11px] text-brand font-semibold tracking-wide uppercase font-mono">
              AI COFOUNDER
            </span>
            <span className="text-sm font-semibold">{resolveCofounderName(cofounder)}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-fg-faint hover:text-fg text-lg leading-none cursor-pointer"
          >
            &times;
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-5">
          <div>
            <FieldLabel>Team Name</FieldLabel>
            <input
              className={inputClass}
              value={name}
              onChange={(e) => markDirty(setName)(e.target.value)}
            />
          </div>

          <div>
            <FieldLabel>Cofounder Name</FieldLabel>
            <input
              className={inputClass}
              value={cofounder}
              onChange={(e) => markDirty(setCofounder)(e.target.value)}
              placeholder={DEFAULT_COFOUNDER_NAME}
            />
          </div>

          <div className="flex-1">
            <FieldLabel>System Prompt</FieldLabel>
            <textarea
              className={`${inputClass} min-h-[300px] font-mono text-xs leading-relaxed resize-y`}
              value={prompt}
              onChange={(e) => markDirty(setPrompt)(e.target.value)}
              placeholder="System prompt for the meta-agent..."
            />
          </div>
        </div>

        <div className="px-5 py-4 border-t border-border flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="text-sm text-fg-muted hover:text-fg cursor-pointer px-3 py-1.5"
          >
            Close
          </button>
          {dirty && (
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="bg-brand text-white text-sm font-medium px-4 py-1.5 rounded disabled:opacity-40 cursor-pointer"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}
