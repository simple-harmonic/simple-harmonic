"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApprovalCard } from "@/components/chat/approval-card";
import { ChatInputBar } from "@/components/chat/input-bar";
import {
  AssistantMessage,
  ErrorMessage,
  ThinkingIndicator,
  UserMessage,
} from "@/components/chat/message";
import { useChat } from "@/components/chat/use-chat";
import { TopBar } from "@/components/top-bar";
import type { SpawnTeamAgent } from "@/lib/meta-agent";

function SpawningScreen({ agentCount }: { agentCount: number }) {
  return (
    <div className="flex flex-col h-full min-h-screen items-center justify-center gap-6">
      <div className="flex gap-2">
        <span className="w-2.5 h-2.5 rounded-full bg-brand animate-pulse" />
        <span className="w-2.5 h-2.5 rounded-full bg-brand animate-pulse [animation-delay:150ms]" />
        <span className="w-2.5 h-2.5 rounded-full bg-brand animate-pulse [animation-delay:300ms]" />
      </div>
      <p className="text-[17px] font-semibold tracking-tight">
        Spinning up {agentCount} agent{agentCount === 1 ? "" : "s"}...
      </p>
      <p className="text-[13px] text-fg-muted">meta-agent is configuring schedules and tools</p>
    </div>
  );
}

export default function NewTeamPage() {
  const router = useRouter();
  const { messages, status, spawnProposal, sendMessage, retry, clearSpawnProposal } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [spawning, setSpawning] = useState<{ count: number } | null>(null);

  const scrollKey = messages.length + (spawnProposal ? 1 : 0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on message count change
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [scrollKey]);

  const handleSpawn = async (payload: {
    agents: SpawnTeamAgent[];
    teamName: string;
    cofounderName: string | null;
  }) => {
    setSpawning({ count: payload.agents.length });
    try {
      const res = await fetch("/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        const { teamId } = await res.json();
        router.push(`/f/${teamId}`);
      } else {
        setSpawning(null);
      }
    } catch {
      setSpawning(null);
    }
  };

  if (spawning) {
    return <SpawningScreen agentCount={spawning.count} />;
  }

  const messageCount = messages.filter((m) => m.role !== "error").length;
  let crumb = "new team";
  if (spawnProposal) crumb = `new team · ready to spawn`;
  else if (messageCount > 1) crumb = `new team · ${messageCount} messages`;

  return (
    <div className="flex flex-col h-full min-h-screen">
      <TopBar
        crumb={crumb}
        right={
          <span className="text-xs text-fg-faint font-mono">
            {spawnProposal ? "aligned" : status === "streaming" ? "thinking..." : "no agents yet"}
          </span>
        }
      />

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="px-16 pt-16 pb-4 max-w-[920px] mx-auto w-full flex flex-col gap-7">
          {messages.map((msg) => {
            const isLast = msg === messages[messages.length - 1];
            const isStreamingMsg = status === "streaming" && isLast;
            // Skip rendering empty assistant message; ThinkingIndicator covers it
            if (msg.role === "assistant" && isStreamingMsg && msg.content === "") {
              return null;
            }
            if (msg.role === "assistant") {
              return (
                <AssistantMessage
                  key={msg.id}
                  message={msg}
                  isStreaming={isStreamingMsg}
                />
              );
            }
            if (msg.role === "user") {
              return <UserMessage key={msg.id} message={msg} />;
            }
            if (msg.role === "error") {
              return <ErrorMessage key={msg.id} message={msg} onRetry={retry} />;
            }
            return null;
          })}

          {status === "streaming" && messages[messages.length - 1]?.content === "" && (
            <ThinkingIndicator />
          )}

          {spawnProposal && (
            <ApprovalCard
              agents={spawnProposal.agents}
              teamName={spawnProposal.teamName}
              cofounderName={spawnProposal.cofounderName}
              onSpawn={handleSpawn}
              onKeepDiscussing={clearSpawnProposal}
              isSpawning={!!spawning}
            />
          )}
        </div>
      </div>

      <div className="px-16 pb-6 pt-4 max-w-[920px] mx-auto w-full">
        <ChatInputBar
          onSend={sendMessage}
          disabled={status === "streaming"}
          placeholder={
            spawnProposal
              ? "Push back or tweak the proposal..."
              : "Tell your AI cofounder about your company..."
          }
        />
      </div>
    </div>
  );
}
