"use client";

import { useCallback, useRef, useState } from "react";
import type { SpawnTeamAgent } from "@simple-harmonic/backend/lib/meta-agent";
import type { ChatMessageData } from "./message";

type ChatStatus = "idle" | "streaming" | "error";

export interface SpawnProposal {
  teamName: string;
  cofounderName: string | null;
  agents: SpawnTeamAgent[];
}

export interface CredentialRequestData {
  key: string;
  label: string;
  reason: string;
  helpUrl: string | null;
}

interface UseChatReturn {
  messages: ChatMessageData[];
  status: ChatStatus;
  spawnProposal: SpawnProposal | null;
  credentialRequest: CredentialRequestData | null;
  sendMessage: (text: string) => void;
  retry: () => void;
  clearSpawnProposal: () => void;
  clearCredentialRequest: () => void;
}

const INITIAL_MESSAGE: ChatMessageData = {
  id: "initial",
  role: "assistant",
  content: "Hi. I'm **Harmon**, your AI manager. How can I help you today?",
  timestamp: new Date().toISOString(),
};

export function useChat(): UseChatReturn {
  const [messages, setMessages] = useState<ChatMessageData[]>([
    INITIAL_MESSAGE,
  ]);
  const [status, setStatus] = useState<ChatStatus>("idle");
  const [spawnProposal, setSpawnProposal] = useState<SpawnProposal | null>(
    null,
  );
  const [credentialRequest, setCredentialRequest] =
    useState<CredentialRequestData | null>(null);
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
        {
          id: assistantId,
          role: "assistant",
          content: "",
          timestamp: new Date().toISOString(),
        },
      ]);

      const allMessages = [...messages, userMsg];
      const apiMessages = allMessages
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }));

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
                    m.id === assistantId
                      ? { ...m, content: m.content + data.text }
                      : m,
                  ),
                );
              } else if (data.type === "spawn") {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: data.content || m.content }
                      : m,
                  ),
                );
                setSpawnProposal({
                  teamName: data.teamName ?? "New Team",
                  cofounderName: data.cofounderName ?? null,
                  agents: data.agents,
                });
                setStatus("idle");
              } else if (data.type === "request_credential") {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: data.content || m.content }
                      : m,
                  ),
                );
                setCredentialRequest({
                  key: data.key,
                  label: data.label,
                  reason: data.reason,
                  helpUrl: data.helpUrl ?? null,
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

  const clearCredentialRequest = useCallback(() => {
    setCredentialRequest(null);
  }, []);

  return {
    messages,
    status,
    spawnProposal,
    credentialRequest,
    sendMessage,
    retry,
    clearSpawnProposal,
    clearCredentialRequest,
  };
}
