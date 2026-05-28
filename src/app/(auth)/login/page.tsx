"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setTimeout(() => router.push("/"), 400);
  };

  const handleSocial = () => {
    setLoading(true);
    setTimeout(() => router.push("/"), 400);
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg">
      <div className="w-full max-w-[360px] px-6">
        <div className="mb-10">
          <h1 className="text-[28px] font-semibold tracking-[-0.02em] text-fg">
            Simple Harmonic
          </h1>
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
              required
            />
          </div>

          <div>
            <label htmlFor="password" className="text-[13px] font-medium text-fg block mb-1.5">
              Password
            </label>
            <input
              id="password"
              type="password"
              placeholder="••••••••"
              autoComplete="current-password"
              className="w-full bg-bg-input border border-border rounded-md px-3 py-2.5 text-[14px] text-fg placeholder:text-fg-faint outline-none focus:border-brand"
            />
          </div>

          <button
            type="submit"
            disabled={loading || !email}
            className="bg-brand text-white py-[11px] px-4 rounded-[5px] text-[14px] font-medium cursor-pointer disabled:opacity-60 mt-1"
          >
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <div className="relative my-6">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center">
            <span className="bg-bg px-3 text-[11px] text-fg-faint font-mono uppercase">or</span>
          </div>
        </div>

        <div className="flex flex-col gap-2.5">
          <button
            type="button"
            onClick={handleSocial}
            disabled={loading}
            className="w-full border border-border rounded-[5px] py-[9px] px-4 text-[13px] font-medium text-fg hover:border-border-strong transition-colors cursor-pointer disabled:opacity-60 flex items-center justify-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Continue with Google
          </button>
          <button
            type="button"
            onClick={handleSocial}
            disabled={loading}
            className="w-full border border-border rounded-[5px] py-[9px] px-4 text-[13px] font-medium text-fg hover:border-border-strong transition-colors cursor-pointer disabled:opacity-60 flex items-center justify-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
            </svg>
            Continue with GitHub
          </button>
        </div>

        <p className="text-[11px] text-fg-faint text-center mt-8 font-mono">
          v0.0 preview: auth is not enforced yet
        </p>
      </div>
    </div>
  );
}
