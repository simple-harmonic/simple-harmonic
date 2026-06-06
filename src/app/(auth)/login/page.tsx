"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (res.ok) {
        router.push("/");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(
        res.status === 503
          ? "Operator login is not configured on this server."
          : (body.error ?? "Invalid password"),
      );
    } catch {
      setError("Could not reach the server. Try again.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="w-full max-w-[360px] px-6">
        <div className="mb-10">
          <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-fg">Simple Harmonic</h1>
          <p className="text-[13px] text-fg-faint mt-1.5">Sign in to continue</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          <div>
            <label htmlFor="email" className="text-[13px] font-medium text-fg block mb-1.5">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              autoComplete="email"
              className="w-full bg-bg-input border border-border rounded-md px-3 py-2.5 text-[14px] text-fg placeholder:text-fg-faint outline-none focus:border-brand"
            />
          </div>

          <div>
            <label htmlFor="password" className="text-[13px] font-medium text-fg block mb-1.5">
              Operator password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              className="w-full bg-bg-input border border-border rounded-md px-3 py-2.5 text-[14px] text-fg placeholder:text-fg-faint outline-none focus:border-brand"
              required
            />
          </div>

          {error && (
            <p className="text-[12px] text-error font-mono" role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={loading || !password}
            className="bg-brand text-white py-[11px] px-4 rounded-[5px] text-[14px] font-medium cursor-pointer disabled:opacity-60 mt-1"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <p className="text-[11px] text-fg-faint text-center mt-8 font-mono">
          v0.0 preview: single shared operator password
        </p>
      </div>
    </div>
  );
}
