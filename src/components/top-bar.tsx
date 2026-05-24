import Link from "next/link";

interface TopBarProps {
  crumb: string;
  right?: React.ReactNode;
}

export function TopBar({ crumb, right }: TopBarProps) {
  return (
    <header className="flex justify-between items-center px-6 py-3.5 border-b border-border bg-bg-elev">
      <div className="flex items-center gap-4">
        <Link
          href="/"
          className="font-semibold tracking-tight text-sm hover:text-brand transition-colors"
        >
          Simple Harmonic
        </Link>
        <span className="text-fg-faint text-xs font-mono">/ {crumb}</span>
      </div>
      <div className="flex items-center gap-5">
        {right}
        <Link
          href="/settings"
          className="text-fg-faint hover:text-fg-muted transition-colors"
          aria-label="Settings"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            role="img"
            aria-label="Settings"
          >
            <title>Settings</title>
            <path
              d="M6.5 1.5L6.8 3.1C6.2 3.3 5.6 3.7 5.1 4.1L3.6 3.5L2.1 6L3.4 7.1C3.4 7.4 3.3 7.7 3.3 8C3.3 8.3 3.4 8.6 3.4 8.9L2.1 10L3.6 12.5L5.1 11.9C5.6 12.3 6.2 12.7 6.8 12.9L7.1 14.5H9.1L9.4 12.9C10 12.7 10.6 12.3 11.1 11.9L12.6 12.5L14.1 10L12.8 8.9C12.8 8.6 12.9 8.3 12.9 8C12.9 7.7 12.8 7.4 12.8 7.1L14.1 6L12.6 3.5L11.1 4.1C10.6 3.7 10 3.3 9.4 3.1L9.1 1.5H6.5ZM8 5.5C9.4 5.5 10.5 6.6 10.5 8C10.5 9.4 9.4 10.5 8 10.5C6.6 10.5 5.5 9.4 5.5 8C5.5 6.6 6.6 5.5 8 5.5Z"
              fill="currentColor"
            />
          </svg>
        </Link>
      </div>
    </header>
  );
}
