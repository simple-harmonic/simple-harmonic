"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ApprovalCard } from "@simple-harmonic/frontend/components/chat/approval-card";
import { CredentialRequestCard } from "@simple-harmonic/frontend/components/chat/credential-request-card";
import { ChatInputBar } from "@simple-harmonic/frontend/components/chat/input-bar";
import {
  AssistantMessage,
  ErrorMessage,
  ThinkingIndicator,
  UserMessage,
} from "@simple-harmonic/frontend/components/chat/message";
import { useChat } from "@simple-harmonic/frontend/components/chat/use-chat";
import type { SpawnTeamAgent } from "@simple-harmonic/backend/lib/meta-agent";

function SpawningScreen({ agentCount }: { agentCount: number }) {
  return (
    <div className="flex flex-col h-full items-center justify-center gap-6">
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
  const { messages, status, spawnProposal, credentialRequest, sendMessage, retry, clearSpawnProposal, clearCredentialRequest } = useChat();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [spawning, setSpawning] = useState<{ count: number } | null>(null);

  const scrollKey = messages.length + (spawnProposal ? 1 : 0) + (credentialRequest ? 1 : 0);
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
  let statusText = "no agents yet";
  if (spawnProposal) statusText = "aligned, ready to spawn";
  else if (status === "streaming") statusText = "thinking...";
  else if (messageCount > 1) statusText = `${messageCount} messages`;

  return (
    <div className="flex flex-col h-full">
      {/* Content header */}
      <div className="flex items-center justify-between px-6 py-3 border-b border-border bg-bg shrink-0">
        <div className="flex items-center gap-3">
          <h1 className="text-[14px] font-semibold">New Team</h1>
          <span className="text-[11px] text-fg-faint font-mono">{statusText}</span>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        <div className="px-12 pt-12 pb-4 max-w-[860px] mx-auto w-full flex flex-col gap-7">
          {messages.map((msg) => {
            const isLast = msg === messages[messages.length - 1];
            const isStreamingMsg = status === "streaming" && isLast;
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

          {credentialRequest && (
            <CredentialRequestCard
              credentialKey={credentialRequest.key}
              label={credentialRequest.label}
              reason={credentialRequest.reason}
              helpUrl={credentialRequest.helpUrl}
              onSubmit={() => clearCredentialRequest()}
            />
          )}
        </div>
      </div>

      <div className="px-12 pb-6 pt-4 max-w-[860px] mx-auto w-full">
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
