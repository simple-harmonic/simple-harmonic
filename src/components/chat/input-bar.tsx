"use client";

import { useCallback, useRef } from "react";

interface ChatInputBarProps {
  onSend: (text: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

export function ChatInputBar({
  onSend,
  disabled = false,
  placeholder = "Tell your AI cofounder about your company...",
}: ChatInputBarProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const text = textareaRef.current?.value.trim();
    if (!text || disabled) return;
    onSend(text);
    if (textareaRef.current) textareaRef.current.value = "";
  }, [onSend, disabled]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div
      className={`bg-bg-input border border-border-strong rounded-[10px] p-1 ${disabled ? "opacity-70" : ""}`}
    >
      <textarea
        ref={textareaRef}
        placeholder={placeholder}
        rows={2}
        disabled={disabled}
        onKeyDown={handleKeyDown}
        className="w-full px-3.5 py-3 bg-transparent border-none resize-none text-fg font-sans text-[15px] leading-normal outline-none placeholder:text-fg-faint disabled:text-fg-faint"
      />
      <div className="flex justify-between items-center px-2 pb-1.5 pt-1">
        <span className="text-[11px] text-fg-faint font-mono">shift+enter for new line</span>
        <button
          type="button"
          onClick={handleSend}
          disabled={disabled}
          className="bg-brand text-white px-3 py-1.5 rounded-[5px] text-xs font-medium cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Send
        </button>
      </div>
    </div>
  );
}
