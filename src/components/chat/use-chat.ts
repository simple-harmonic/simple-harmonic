"use client";

import { useCallback, useRef, useState } from "react";
import type { SpawnTeamAgent } from "@/lib/meta-agent";
import type { ChatMessageData } from "./message";

type ChatStatus = "idle" | "streaming" | "error";

export interface SpawnProposal {
  teamName: string;
  cofounderName: string | null;
  agents: SpawnTeamAgent[];
}

interface UseChatReturn {
  messages: ChatMessageData[];
  status: ChatStatus;
  spawnProposal: SpawnProposal | null;
  sendMessage: (text: string) => void;
  retry: () => void;
  clearSpawnProposal: () => void;
}

const INITIAL_MESSAGE: ChatMessageData = {
  id: "initial",
  role: "assistant",
  content:
    "Hi. I'm **Harmon**, your AI cofounder. Before I spin up a team, I want to understand what you actually do day-to-day so the agents are useful, not generic.\n\nWalk me through your company. Three things: **what you do**, **who pays you** (or would), and **what's currently eating your week**. Start anywhere. I'll ask follow-ups.\n\n(If you'd rather call me something else, just say so.)",
  timestamp: new Date().toISOString(),
};

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessageData[]>([INITIAL_MESSAGE]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [spawnProposal, setSpawnProposal] = useState<SpawnProposal | null>(null);
  const streamingIdRef = useRef<string | null>(null);

  const sendMessage = useCallback(
    (text: string) => {
      if (status === "streaming") return;

      const userMsg: ChatMessageData = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      };

      setMessages((prev) => [...prev, userMsg]);
      setStatus("streaming");
      setSpawnProposal(null);

      const assistantId = crypto.randomUUID();
      streamingIdRef.current = assistantId;

      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "", timestamp: new Date().toISOString() },
      ]);

      const allMessages = [...messages, userMsg];
      const apiMessages = allMessages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

      fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: apiMessages }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const reader = res.body?.getReader();
          if (!reader) throw new Error("No response body");

          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const data = JSON.parse(line.slice(6));

              if (data.type === "token") {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, content: m.content + data.text } : m,
                  ),
                );
              } else if (data.type === "spawn") {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, content: data.content || m.content } : m,
                  ),
                );
                setSpawnProposal({
                  teamName: data.teamName ?? "New Team",
                  cofounderName: data.cofounderName ?? null,
                  agents: data.agents,
                });
                setStatus("idle");
              } else if (data.type === "done") {
                setStatus("idle");
              } else if (data.type === "error") {
                setMessages((prev) => [
                  ...prev.filter((m) => m.id !== assistantId),
                  {
                    id: crypto.randomUUID(),
                    role: "error" as const,
                    content: data.message,
                    timestamp: new Date().toISOString(),
                  },
                ]);
                setStatus("error");
              }
            }
          }

          setStatus((prev) => (prev === "streaming" ? "idle" : prev));
        })
        .catch((err) => {
          setMessages((prev) => [
            ...prev.filter((m) => m.id !== assistantId),
            {
              id: crypto.randomUUID(),
              role: "error" as const,
              content: err instanceof Error ? err.message : "Connection failed",
              timestamp: new Date().toISOString(),
            },
          ]);
          setStatus("error");
        });
    },
    [messages, status],
  );

  const retry = useCallback(() => {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    if (lastUserMsg) {
      setMessages((prev) => prev.filter((m) => m.role !== "error"));
      sendMessage(lastUserMsg.content);
    }
  }, [messages, sendMessage]);

  const clearSpawnProposal = useCallback(() => {
    setSpawnProposal(null);
  }, []);

  return { messages, status, spawnProposal, sendMessage, retry, clearSpawnProposal };
}
