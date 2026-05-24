import Link from "next/link";

export default function Home() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <h1 className="text-[56px] font-semibold tracking-[-0.025em] leading-[1.05] mb-3">
          Simple Harmonic
        </h1>
        <p className="text-[14px] text-fg-faint tracking-[0.05em] uppercase font-mono mb-20">
          built by agents. run by agents. managed by agents. (with you)
        </p>
        <nav className="flex gap-12 justify-center">
          <Link
            href="/new"
            className="text-fg-muted text-[14px] font-medium py-2 border-b border-transparent hover:text-fg hover:border-b-brand transition-colors"
          >
            <span className="text-brand mr-1.5">+</span>
            New
          </Link>
          <Link
            href="/teams"
            className="text-fg-muted text-[14px] font-medium py-2 border-b border-transparent hover:text-fg hover:border-b-brand transition-colors"
          >
            <span className="text-brand mr-1.5">&#x25CE;</span>
            Teams
          </Link>
          <Link
            href="/settings"
            className="text-fg-muted text-[14px] font-medium py-2 border-b border-transparent hover:text-fg hover:border-b-brand transition-colors"
          >
            <span className="text-brand mr-1.5">&#x2699;</span>
            Settings
          </Link>
        </nav>
      </div>
    </div>
  );
}
