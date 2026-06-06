import { describe, expect, it, vi } from "vitest";

// Mock the DB with in-memory team data
const mockTeams = [
  { id: "root", parentTeamId: null, name: "Root", paused: false, tickCount: 0, metaAgentPrompt: null, cofounderName: null, lastUserActiveAt: new Date(), createdAt: new Date() },
  { id: "eng", parentTeamId: "root", name: "Engineering", paused: false, tickCount: 0, metaAgentPrompt: null, cofounderName: null, lastUserActiveAt: new Date(), createdAt: new Date() },
  { id: "frontend", parentTeamId: "eng", name: "Frontend", paused: false, tickCount: 0, metaAgentPrompt: null, cofounderName: null, lastUserActiveAt: new Date(), createdAt: new Date() },
  { id: "backend", parentTeamId: "eng", name: "Backend", paused: false, tickCount: 0, metaAgentPrompt: null, cofounderName: null, lastUserActiveAt: new Date(), createdAt: new Date() },
  { id: "growth", parentTeamId: "root", name: "Growth", paused: false, tickCount: 0, metaAgentPrompt: null, cofounderName: null, lastUserActiveAt: new Date(), createdAt: new Date() },
];

vi.mock("@/server/db", () => ({
  db: () => ({
    query: {
      teams: {
        findMany: vi.fn().mockImplementation(({ where } = {}) => {
          if (!where) return Promise.resolve(mockTeams);
          return Promise.resolve(mockTeams);
        }),
      },
    },
  }),
}));

// For the functions that use eq/isNull, we need to override
// the imports to work with our mock. The simplest approach:
// import the functions and test them against the mock.

describe("team tree helpers", () => {
  it("getSubTreeIds returns the full sub-tree from root", async () => {
    const { getSubTreeIds } = await import("@/server/team-tree");
    const ids = await getSubTreeIds("root");
    expect(ids).toEqual(new Set(["root", "eng", "frontend", "backend", "growth"]));
  });

  it("getSubTreeIds returns sub-tree from a mid-level node", async () => {
    const { getSubTreeIds } = await import("@/server/team-tree");
    const ids = await getSubTreeIds("eng");
    expect(ids).toEqual(new Set(["eng", "frontend", "backend"]));
  });

  it("getSubTreeIds returns just the leaf for a leaf node", async () => {
    const { getSubTreeIds } = await import("@/server/team-tree");
    const ids = await getSubTreeIds("frontend");
    expect(ids).toEqual(new Set(["frontend"]));
  });

  it("isAncestor returns true for self", async () => {
    const { isAncestor } = await import("@/server/team-tree");
    expect(await isAncestor("eng", "eng")).toBe(true);
  });

  it("isAncestor returns true for parent", async () => {
    const { isAncestor } = await import("@/server/team-tree");
    expect(await isAncestor("root", "eng")).toBe(true);
  });

  it("isAncestor returns true for grandparent", async () => {
    const { isAncestor } = await import("@/server/team-tree");
    expect(await isAncestor("root", "frontend")).toBe(true);
  });

  it("isAncestor returns false for sibling", async () => {
    const { isAncestor } = await import("@/server/team-tree");
    expect(await isAncestor("growth", "eng")).toBe(false);
  });

  it("isAncestor returns false for child-to-parent direction", async () => {
    const { isAncestor } = await import("@/server/team-tree");
    expect(await isAncestor("frontend", "root")).toBe(false);
  });

  it("getAncestorChain walks up to root", async () => {
    const { getAncestorChain } = await import("@/server/team-tree");
    const chain = await getAncestorChain("frontend");
    expect(chain).toEqual(["frontend", "eng", "root"]);
  });

  it("getAncestorChain for root is just root", async () => {
    const { getAncestorChain } = await import("@/server/team-tree");
    const chain = await getAncestorChain("root");
    expect(chain).toEqual(["root"]);
  });

  it("getTeamTree builds the full tree", async () => {
    const { getTeamTree } = await import("@/server/team-tree");
    const tree = await getTeamTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe("Root");
    expect(tree[0].children).toHaveLength(2);
    const eng = tree[0].children.find((c) => c.name === "Engineering");
    expect(eng?.children).toHaveLength(2);
    expect(eng?.children.map((c) => c.name).sort()).toEqual(["Backend", "Frontend"]);
  });
});
