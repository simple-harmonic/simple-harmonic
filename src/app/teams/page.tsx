"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TopBar } from "@/components/top-bar";

interface Team {
  id: string;
  name: string;
  paused: boolean;
  tickCount: number;
  createdAt: string;
}

export default function TeamsPage() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/teams")
      .then((res) => res.json())
      .then((data) => {
        setTeams(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-bg">
      <TopBar crumb="Teams" />
      <main className="max-w-2xl mx-auto px-6 py-12">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-lg font-semibold">Teams</h1>
          <Link
            href="/new"
            className="text-sm font-medium text-brand hover:text-brand/80 transition-colors"
          >
            + New Team
          </Link>
        </div>

        {loading ? (
          <p className="text-sm text-fg-faint font-mono">loading...</p>
        ) : teams.length === 0 ? (
          <div className="border border-border rounded-lg p-8 text-center">
            <p className="text-sm text-fg-faint mb-4">No teams yet.</p>
            <Link
              href="/new"
              className="text-sm font-medium text-brand hover:underline"
            >
              Create your first team
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {teams.map((f) => (
              <Link
                key={f.id}
                href={`/f/${f.id}`}
                className="border border-border rounded-lg px-5 py-4 hover:border-fg-faint transition-colors group"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span
                      className={`w-2 h-2 rounded-full ${f.paused ? "bg-fg-faint" : "bg-green-500"}`}
                    />
                    <span className="text-sm font-medium group-hover:text-fg transition-colors">
                      {f.name}
                    </span>
                  </div>
                  <span className="text-xs text-fg-faint font-mono">
                    {f.tickCount} ticks
                  </span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
