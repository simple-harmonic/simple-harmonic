import { beforeEach, describe, expect, it } from "vitest";
import {
  getAncestorChain,
  getChildTeams,
  getRootTeams,
  getSubTreeIds,
  getTeamTree,
  isAncestor,
} from "@/server/team-tree";
import { teams } from "@/server/store";
import { useTempStore } from "../helpers/store";

// A small fixed tree, built fresh per test with generated UUIDs:
//
//   Root
//   ├── Engineering
//   │   ├── Frontend
//   │   └── Backend
//   └── Growth
//
let root: string;
let eng: string;
let frontend: string;
let backend: string;
let growth: string;

describe("team tree helpers", () => {
  useTempStore();

  beforeEach(async () => {
    root = (await teams.insert({ name: "Root" })).id;
    eng = (await teams.insert({ name: "Engineering", parentTeamId: root })).id;
    frontend = (await teams.insert({ name: "Frontend", parentTeamId: eng })).id;
    backend = (await teams.insert({ name: "Backend", parentTeamId: eng })).id;
    growth = (await teams.insert({ name: "Growth", parentTeamId: root })).id;
  });

  // -------------------------------------------------------------------------
  // getRootTeams
  // -------------------------------------------------------------------------

  it("getRootTeams returns only parentless teams", async () => {
    const roots = await getRootTeams();
    expect(roots.map((t) => t.id)).toEqual([root]);
  });

  // -------------------------------------------------------------------------
  // getChildTeams
  // -------------------------------------------------------------------------

  it("getChildTeams returns direct children only", async () => {
    const children = await getChildTeams(root);
    expect(children.map((t) => t.id).sort()).toEqual([eng, growth].sort());
  });

  it("getChildTeams returns an empty list for a leaf", async () => {
    expect(await getChildTeams(frontend)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // getSubTreeIds
  // -------------------------------------------------------------------------

  it("getSubTreeIds returns the full sub-tree from root", async () => {
    const ids = await getSubTreeIds(root);
    expect(ids).toEqual(new Set([root, eng, frontend, backend, growth]));
  });

  it("getSubTreeIds returns the sub-tree from a mid-level node", async () => {
    const ids = await getSubTreeIds(eng);
    expect(ids).toEqual(new Set([eng, frontend, backend]));
  });

  it("getSubTreeIds returns just the leaf for a leaf node", async () => {
    const ids = await getSubTreeIds(frontend);
    expect(ids).toEqual(new Set([frontend]));
  });

  // -------------------------------------------------------------------------
  // isAncestor
  // -------------------------------------------------------------------------

  it("isAncestor returns true for self", async () => {
    expect(await isAncestor(eng, eng)).toBe(true);
  });

  it("isAncestor returns true for a direct parent", async () => {
    expect(await isAncestor(root, eng)).toBe(true);
  });

  it("isAncestor returns true for a grandparent", async () => {
    expect(await isAncestor(root, frontend)).toBe(true);
  });

  it("isAncestor returns false for a sibling", async () => {
    expect(await isAncestor(growth, eng)).toBe(false);
  });

  it("isAncestor returns false for the child-to-parent direction", async () => {
    expect(await isAncestor(frontend, root)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // getAncestorChain
  // -------------------------------------------------------------------------

  it("getAncestorChain walks up to the root", async () => {
    expect(await getAncestorChain(frontend)).toEqual([frontend, eng, root]);
  });

  it("getAncestorChain for the root is just the root", async () => {
    expect(await getAncestorChain(root)).toEqual([root]);
  });

  // -------------------------------------------------------------------------
  // getTeamTree
  // -------------------------------------------------------------------------

  it("getTeamTree builds the full nested tree", async () => {
    const tree = await getTeamTree();
    expect(tree).toHaveLength(1);
    expect(tree[0].id).toBe(root);
    expect(tree[0].name).toBe("Root");
    expect(tree[0].children).toHaveLength(2);

    const engNode = tree[0].children.find((c) => c.name === "Engineering");
    expect(engNode?.id).toBe(eng);
    expect(engNode?.children.map((c) => c.name).sort()).toEqual(["Backend", "Frontend"]);

    const growthNode = tree[0].children.find((c) => c.name === "Growth");
    expect(growthNode?.children).toEqual([]);
  });
});
