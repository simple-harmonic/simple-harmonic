"use client";

function FormattedText({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part) => {
        const key = part.slice(0, 20);
        if (part.startsWith("**") && part.endsWith("**")) {
          return <strong key={key}>{part.slice(2, -2)}</strong>;
        }
        return <span key={key}>{part}</span>;
      })}
    </>
  );
}

export interface ChatMessageData {
  id: string;
  role: "user" | "assistant" | "error";
  content: string;
  isPushback?: boolean;
  timestamp?: string;
}

function formatTime(date?: string) {
  if (!date) return "";
  return new Date(date).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function MetaAgentBadge() {
  return (
    <span className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-[4px] bg-brand-soft border border-brand text-brand text-[11px] font-semibold font-mono">
      M
    </span>
  );
}

function ErrorBadge() {
  return (
    <span className="inline-flex items-center justify-center w-[22px] h-[22px] rounded-[4px] bg-error/10 border border-error text-error text-[11px] font-semibold font-mono">
      !
    </span>
  );
}

export function AssistantMessage({
  message,
  isStreaming,
}: {
  message: ChatMessageData;
  isStreaming?: boolean;
}) {
  return (
    <div className="w-full">
      <div className="flex items-center gap-2.5 mb-2.5">
        <MetaAgentBadge />
        <span className="text-[13px] font-semibold text-brand">meta-agent</span>
        {message.timestamp && (
          <span className="text-[11px] text-fg-faint font-mono">
            {formatTime(message.timestamp)}
          </span>
        )}
        {message.isPushback && (
          <span className="text-[11px] text-fg-faint font-mono ml-1">· pushback</span>
        )}
      </div>
      <div className="text-[15px] leading-relaxed max-w-[64ch] whitespace-pre-wrap">
        <FormattedText text={message.content} />
        {isStreaming && <span className="inline-block w-2 h-4 bg-brand ml-0.5 animate-pulse" />}
      </div>
    </div>
  );
}

export function UserMessage({ message }: { message: ChatMessageData }) {
  return (
    <div className="flex justify-end w-full">
      <div className="max-w-[60ch] bg-bg-input border border-border px-4 py-3 rounded-lg text-[15px] leading-relaxed">
        {message.content}
      </div>
    </div>
  );
}

export function ErrorMessage({
  message,
  onRetry,
}: {
  message: ChatMessageData;
  onRetry?: () => void;
}) {
  return (
    <div className="w-full">
      <div className="flex items-center gap-2.5 mb-2.5">
        <ErrorBadge />
        <span className="text-[13px] font-semibold text-error">connection error</span>
        {message.timestamp && (
          <span className="text-[11px] text-fg-faint font-mono">
            {formatTime(message.timestamp)}
          </span>
        )}
      </div>
      <div className="text-sm leading-relaxed text-fg-muted max-w-[64ch]">
        <p>{message.content}</p>
        {onRetry && (
          <div className="mt-3 flex gap-3 items-center">
            <button
              type="button"
              onClick={onRetry}
              className="bg-brand text-white py-[7px] px-3.5 rounded-[5px] text-[13px] font-medium cursor-pointer"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ThinkingIndicator() {
  return (
    <div className="w-full">
      <div className="flex items-center gap-2.5">
        <MetaAgentBadge />
        <span className="text-[13px] font-semibold text-brand">meta-agent</span>
        <div className="flex gap-1 ml-1">
          <span className="w-1.5 h-1.5 rounded-full bg-brand animate-pulse" />
          <span className="w-1.5 h-1.5 rounded-full bg-brand animate-pulse [animation-delay:150ms]" />
          <span className="w-1.5 h-1.5 rounded-full bg-brand animate-pulse [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}
