"use client";

interface PausedBannerProps {
  pausedAt?: string;
}

export function PausedBanner({ pausedAt }: PausedBannerProps) {
  const time = pausedAt
    ? new Date(pausedAt).toLocaleTimeString("en-US", {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "just now";

  return (
    <div className="bg-brand-soft border-b border-brand px-6 py-2 text-xs text-orange-200 flex justify-between font-mono">
      <span>● team paused by you · {time}</span>
      <span>resume to continue</span>
    </div>
  );
}
