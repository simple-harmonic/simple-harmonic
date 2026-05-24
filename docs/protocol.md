# Simple Harmonic Wire Protocol (PWP) v0.1

Internal protocol for agent-to-agent communication within a Simple Harmonic team.
Designed for small teams (3-10 agents) with a meta-agent orchestrator.

## Design principles

- DB-backed, not network-backed. All messages are rows in Postgres.
- Every message has a type, a channel, and a lifecycle.
- The meta-agent is a peer, not a router. It can send and receive like any agent.
- Agents pull messages on their tick. No push, no websockets between agents.
- Human-readable. Messages are JSON, inspectable in the UI.

---

## 1. Message envelope

Every message follows this shape:

```
{
  id:          uuid
  teamId:     uuid
  channelType: "direct" | "broadcast" | "group" | "task"
  channelId:   string          // see Channel Types below
  fromAgentId: uuid
  role:        "agent" | "meta" | "system"
  kind:        string          // message kind, see below
  content:     string          // primary text content
  payload:     json | null     // structured data (tool results, artifacts, etc.)
  replyTo:     uuid | null     // threads a reply to a previous message
  status:      "pending" | "delivered" | "read" | "expired"
  expiresAt:   timestamp | null
  createdAt:   timestamp
}
```

## 2. Channel types

### Direct (one-to-one)
- `channelType: "direct"`
- `channelId: "{sortedAgentId1}:{sortedAgentId2}"` (deterministic, same channel both directions)
- Only the two agents can read/write.

### Broadcast (one-to-all)
- `channelType: "broadcast"`
- `channelId: "team:{teamId}"` 
- Any agent can send. All agents in the team receive it on next tick.
- Use for announcements, shared findings, alerts.

### Group (named subset)
- `channelType: "group"`
- `channelId: "group:{groupId}"` where groupId is a uuid
- Membership tracked in `channel_members` table.
- Use for sub-teams (e.g. "content-pipeline" = content-scheduler + research-summarizer).

### Task (structured work request)
- `channelType: "task"`
- `channelId: "task:{taskId}"` where taskId is a uuid
- Has a lifecycle: submitted -> accepted -> working -> completed | failed | canceled
- Supports input_required for multi-turn.
- All messages on a task channel are the conversation about that task.

## 3. Message kinds

### General (all channel types)
- `text`        — plain text message
- `data`        — structured JSON in payload
- `artifact`    — output artifact (file ref, report, draft)
- `ack`         — acknowledgment of receipt
- `error`       — error report

### Task-specific kinds
- `task.create`          — initial task request (payload has title, description, assignee)
- `task.accept`          — agent accepts the task
- `task.status`          — status update (payload has state enum)
- `task.input_required`  — agent needs more info to continue
- `task.result`          — final output (payload has artifacts)
- `task.cancel`          — requestor cancels the task
- `task.reject`          — agent declines the task

### System kinds
- `system.join`       — agent joined a group
- `system.leave`      — agent left a group
- `system.created`    — channel/group created

## 4. Task lifecycle

```
             ┌─── rejected
             │
submitted ───┤─── accepted ──── working ───┬─── completed
             │                     │        │
             └─── canceled         │        └─── failed
                                   │
                              input_required
                                   │
                              (new message)
                                   │
                               working ...
```

Task states: `submitted`, `accepted`, `working`, `input_required`, `completed`, `failed`, `canceled`, `rejected`

## 5. Delivery model

- Agents do NOT receive messages in real-time.
- On each tick, the runner queries for unread messages where:
  - `status = 'pending'` or `status = 'delivered'`
  - Channel matches: direct to this agent, broadcast in team, group membership, or assigned task
  - `expiresAt` is null or in the future
- Messages are injected into the agent's context before the LLM call.
- After the tick, consumed messages are marked `read`.
- Agents can produce new messages as tool call outputs during their tick.

## 6. Runner integration

Before each agent tick:
1. Fetch unread direct messages (channelType=direct, channelId contains agentId)
2. Fetch unread broadcasts (channelType=broadcast, channelId=team:{teamId})
3. Fetch unread group messages (channelType=group, agent in channel_members)
4. Fetch active task messages (channelType=task, agent is assignee or requestor)
5. Format as context block, append to system prompt
6. After tick, mark fetched messages as `read`
7. Parse agent output for `send_message` / `create_task` / `update_task` tool calls
8. Insert resulting messages into the DB

## 7. Context format (injected into agent prompt)

```
--- Messages since last tick ---

[direct from content-distribution-agent]:
Here are 3 draft titles for this week's thread...

[broadcast from founder-research-scout]:
New competitor launched: AgentOps pricing at $29/mo

[group:content-pipeline from content-distribution-agent]:
Draft ready for review. See artifact below.

[task:abc123 from meta-agent] (status: submitted):
Title: Weekly metrics summary
Description: Compile this week's agent activity into a brief for the founder.
---
```

## 8. Agent tools for messaging

Agents get these tools during their tick:

```
send_message(to: agentId | "broadcast" | groupId, content: string, payload?: json)
create_task(assignee: agentId, title: string, description: string)
update_task(taskId: string, status: string, content?: string, payload?: json)
reply(messageId: string, content: string)
```

## 9. Tables

### pwp_messages
Primary message store. Schema matches the envelope in section 1.

### pwp_channels
```
id:          string (channelId)
teamId:     uuid
channelType: "direct" | "broadcast" | "group" | "task"
name:        string | null      // human-readable name for groups
metadata:    json | null
createdAt:   timestamp
```

### pwp_channel_members
```
channelId:   string
agentId:     uuid
joinedAt:    timestamp
```

### pwp_tasks
```
id:           uuid
teamId:      uuid
channelId:    string            // "task:{id}"
requestorId:  uuid              // agent who created the task
assigneeId:   uuid              // agent assigned to do it
title:        string
description:  string
state:        task state enum
metadata:     json | null
createdAt:    timestamp
updatedAt:    timestamp
```

## 10. Limits (v0.0)

- Max message content: 4096 chars
- Max payload size: 16KB JSON
- Max messages per tick context: 20 (oldest dropped with "[N older messages truncated]")
- Message expiry default: 7 days
- Max groups per team: 10
- Max active tasks per agent: 5
