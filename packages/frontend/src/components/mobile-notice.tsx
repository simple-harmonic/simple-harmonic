"use client";

import { useEffect, useState } from "react";

export function MobileNotice() {
  const [dismissed, setDismissed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    setIsMobile(mq.matches);

    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  if (!isMobile || dismissed) return null;

  return (
    <div className="fixed inset-0 z-50 bg-bg/95 flex items-center justify-center px-6">
      <div className="max-w-[340px] text-center flex flex-col items-center gap-4">
        <span className="text-[32px]">⚙️</span>
        <p className="text-[17px] font-semibold tracking-tight">Best on desktop</p>
        <p className="text-[13px] text-fg-muted leading-relaxed">
          Simple Harmonic's agent graph and narration sidebar need a wider viewport. Mobile support comes
          in v0.3.
        </p>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="text-[13px] text-brand font-medium cursor-pointer mt-2"
        >
          Continue anyway →
        </button>
      </div>
    </div>
  );
}
