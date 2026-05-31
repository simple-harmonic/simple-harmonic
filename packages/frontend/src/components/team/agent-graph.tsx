"use client";

import {
  Background,
  BackgroundVariant,
  type Edge,
  type Node,
  type NodeMouseHandler,
  Position,
  ReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

interface AgentData extends Record<string, unknown> {
  id: string;
  name: string;
  role: string;
  status: "running" | "paused" | "errored" | "awaiting_approval";
  inFlight: boolean;
  scheduleSeconds: number;
}

function formatSchedule(seconds: number): string {
  if (seconds < 60) return `every ${seconds}s`;
  if (seconds < 3600) return `every ${Math.round(seconds / 60)}m`;
  return `every ${Math.round(seconds / 3600)}h`;
}

// Use CSS variables so colors adapt to the active theme.
const STATUS_COLORS = {
  running: "var(--running)",
  paused: "var(--paused)",
  errored: "var(--error)",
  awaiting_approval: "var(--brand)",
};

function AccentBadge({ color, label }: { color: string; label: string }) {
  return (
    <span
      className="text-[9px] font-mono uppercase tracking-[1px] px-2 py-0.5 rounded-sm"
      style={{ color, background: `color-mix(in srgb, ${color} 12%, transparent)` }}
    >
      {label}
    </span>
  );
}

function UserNode({ data }: { data: { userName: string } }) {
  return (
    <div className="flex border border-border rounded-sm overflow-hidden w-[520px] cursor-pointer hover:border-border-strong transition-colors">
      <div className="w-1 shrink-0 bg-user" />
      <div className="flex-1 bg-bg-elev px-4 py-3 flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[14px]">{data.userName}</span>
            <AccentBadge color="var(--user)" label="FOUNDER" />
          </div>
          <AccentBadge color="var(--user)" label="ONLINE" />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-fg-faint font-mono truncate">
            Steers agents, sends messages, makes final calls
          </span>
          <span className="text-[10px] text-fg-faint font-mono shrink-0 ml-3">
            always on
          </span>
        </div>
      </div>
    </div>
  );
}

function MetaAgentNode({ data }: { data: { cofounderName: string } }) {
  return (
    <div className="flex border border-border rounded-sm overflow-hidden w-[520px] cursor-pointer hover:border-border-strong transition-colors">
      <div className="w-1 shrink-0 bg-meta" />
      <div className="flex-1 bg-bg-elev px-4 py-3 flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[14px]">{data.cofounderName}</span>
            <AccentBadge color="var(--meta)" label="AI COFOUNDER" />
          </div>
          <AccentBadge color="var(--running)" label="RUNNING" />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-fg-faint font-mono truncate">
            Plans teams, approves ticks, coordinates strategy
          </span>
          <span className="text-[10px] text-fg-faint font-mono shrink-0 ml-3">
            always on
          </span>
        </div>
      </div>
    </div>
  );
}

function AgentNode({ data }: { data: AgentData }) {
  const statusColor = STATUS_COLORS[data.status];
  const statusLabel = data.inFlight ? "THINKING" : data.status.replace(/_/g, " ").toUpperCase();

  return (
    <div className="flex border border-border rounded-sm overflow-hidden w-[520px] cursor-pointer hover:border-border-strong transition-colors">
      <div
        className={`w-1 shrink-0 ${data.inFlight ? "animate-pulse" : ""}`}
        style={{ background: statusColor }}
      />
      <div className="flex-1 bg-bg-elev px-4 py-3 flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="font-semibold text-[14px] truncate">{data.name}</span>
          <AccentBadge color={statusColor} label={statusLabel} />
        </div>
        <div className="flex items-center justify-between">
          <span className="text-[11px] text-fg-faint font-mono truncate">
            {data.role}
          </span>
          <span className="text-[10px] text-fg-faint font-mono shrink-0 ml-3">
            {formatSchedule(data.scheduleSeconds)}
          </span>
        </div>
      </div>
    </div>
  );
}

const nodeTypes = {
  user: UserNode,
  metaAgent: MetaAgentNode,
  agent: AgentNode,
};

interface AgentGraphProps {
  agents: AgentData[];
  cofounderName: string;
  userName: string;
  onAgentClick?: (id: string) => void;
  onMetaAgentClick?: () => void;
  onUserClick?: () => void;
}

export function AgentGraph({ agents, cofounderName, userName, onAgentClick, onMetaAgentClick, onUserClick }: AgentGraphProps) {
  const rowHeight = 90;
  const metaY = 100;
  const agentStartY = metaY + 100;

  const nodes: Node[] = [
    {
      id: "user",
      type: "user",
      position: { x: 0, y: 0 },
      data: { userName },
      sourcePosition: Position.Bottom,
    },
    {
      id: "meta",
      type: "metaAgent",
      position: { x: 0, y: metaY },
      data: { cofounderName },
      sourcePosition: Position.Bottom,
      targetPosition: Position.Top,
    },
    ...agents.map((a, i) => ({
      id: a.id,
      type: "agent" as const,
      position: { x: 0, y: agentStartY + i * rowHeight },
      data: a,
      targetPosition: Position.Top as Position,
    })),
  ];

  const handleNodeClick: NodeMouseHandler = (_event, node) => {
    if (node.type === "agent" && onAgentClick) {
      onAgentClick(node.id);
    } else if (node.type === "metaAgent" && onMetaAgentClick) {
      onMetaAgentClick();
    } else if (node.type === "user" && onUserClick) {
      onUserClick();
    }
  };

  const edges: Edge[] = [
    {
      id: "user-meta",
      source: "user",
      target: "meta",
      style: { stroke: "var(--user)", strokeWidth: 1.5 },
      animated: true,
    },
    ...agents.map((a) => ({
      id: `meta-${a.id}`,
      source: "meta",
      target: a.id,
      style: { stroke: "var(--border-strong)", strokeWidth: 1.5 },
      animated: a.status === "running" || a.status === "awaiting_approval",
    })),
  ];

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        fitView
        fitViewOptions={{ maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag={false}
        zoomOnScroll={false}
        zoomOnPinch={false}
        zoomOnDoubleClick={false}
      >
        <Background variant={BackgroundVariant.Dots} color="var(--border)" gap={24} size={1} />
      </ReactFlow>
    </div>
  );
}
