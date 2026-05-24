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
  status: "running" | "paused" | "errored";
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
};

function MetaAgentNode({ data }: { data: { cofounderName: string } }) {
  return (
    <div className="border-[1.5px] border-brand bg-brand-soft rounded-lg px-8 py-5 min-w-[320px] text-center cursor-pointer hover:border-brand hover:bg-brand-soft/80 transition-colors">
      <div className="text-[13px] text-brand font-semibold tracking-wide uppercase font-mono">
        AI COFOUNDER
      </div>
      <div className="font-semibold text-[18px] mt-1.5">{data.cofounderName}</div>
      <div className="text-[13px] text-fg-muted mt-1 font-mono">supervising</div>
    </div>
  );
}

function AgentNode({ data }: { data: AgentData }) {
  return (
    <div className="border border-border bg-bg-elev rounded-lg px-5 py-4 w-[480px] cursor-pointer hover:border-brand/50 transition-colors">
      <div className="flex items-center gap-2.5 mb-2">
        <span
          className={`w-2 h-2 rounded-full shrink-0 ${data.inFlight ? "animate-pulse" : ""}`}
          style={{ backgroundColor: STATUS_COLORS[data.status] }}
        />
        <span className="font-semibold text-[15px] truncate">{data.name}</span>
        <span
          className="text-[12px] font-mono ml-auto shrink-0"
          style={{ color: STATUS_COLORS[data.status] }}
        >
          {data.inFlight ? "thinking" : data.status}
        </span>
      </div>
      <div className="text-[13px] text-fg-muted font-mono leading-snug line-clamp-1 mb-1">
        {data.role}
      </div>
      <div className="text-[12px] text-fg-faint font-mono">
        {formatSchedule(data.scheduleSeconds)}
      </div>
    </div>
  );
}

const nodeTypes = {
  metaAgent: MetaAgentNode,
  agent: AgentNode,
};

interface AgentGraphProps {
  agents: AgentData[];
  cofounderName: string;
  onAgentClick?: (id: string) => void;
  onMetaAgentClick?: () => void;
}

export function AgentGraph({ agents, cofounderName, onAgentClick, onMetaAgentClick }: AgentGraphProps) {
  const rowHeight = 100;
  const startY = 160;

  const nodes: Node[] = [
    {
      id: "meta",
      type: "metaAgent",
      position: { x: 0, y: 0 },
      data: { cofounderName },
      sourcePosition: Position.Bottom,
    },
    ...agents.map((a, i) => ({
      id: a.id,
      type: "agent" as const,
      position: { x: 0, y: startY + i * rowHeight },
      data: a,
      targetPosition: Position.Top as Position,
    })),
  ];

  const handleNodeClick: NodeMouseHandler = (_event, node) => {
    if (node.type === "agent" && onAgentClick) {
      onAgentClick(node.id);
    } else if (node.type === "metaAgent" && onMetaAgentClick) {
      onMetaAgentClick();
    }
  };

  const edges: Edge[] = agents.map((a) => ({
    id: `meta-${a.id}`,
    source: "meta",
    target: a.id,
    style: { stroke: "var(--border-strong)", strokeWidth: 1.5 },
    animated: a.status === "running",
  }));

  return (
    <div className="w-full h-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        fitView
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
