import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { matchPath, type RouteModule, routes } from "../../src/server/standalone/routes";

// ---------------------------------------------------------------------------
// Parity guard: the standalone route manifest and the Next.js wrapper tree
// (repo-root src/app/api/**) are two views of the same API surface. A route
// added to one but not the other ships an API that exists in one host and
// 404s in the other.
// ---------------------------------------------------------------------------

const APP_API_DIR = join(__dirname, "../../../../src/app/api");
const BACKEND_API_DIR = join(__dirname, "../../src/server/api");

/** Every src/app/api/**\/route.ts, as "/api/team/:id/trace"-style patterns. */
function wrapperPatterns(): Map<string, string> {
  const out = new Map<string, string>(); // pattern -> wrapper file path
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") {
        const rel = relative(APP_API_DIR, full).split(sep).slice(0, -1).join("/");
        const pattern = `/api${rel ? `/${rel}` : ""}`.replace(/\[([^\]]+)\]/g, ":$1");
        out.set(pattern, full);
      }
    }
  };
  walk(APP_API_DIR);
  return out;
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

function moduleMethods(mod: RouteModule): string[] {
  return HTTP_METHODS.filter((m) => typeof mod[m] === "function");
}

describe("standalone route manifest", () => {
  const wrappers = wrapperPatterns();

  it("covers exactly the routes the Next app exposes", () => {
    const manifestPatterns = routes.map((r) => r.pattern).sort();
    const appPatterns = [...wrappers.keys()].sort();
    expect(manifestPatterns).toEqual(appPatterns);
  });

  it("every manifest module exports at least one HTTP method", () => {
    for (const { pattern, module } of routes) {
      expect(moduleMethods(module), pattern).not.toEqual([]);
    }
  });

  it("every Next wrapper is a thin re-export of the backend handler", () => {
    const wrapperShape =
      /^(?:\/\/[^\n]*\n)*export \{ ([A-Z, ]+) \} from "@simple-harmonic\/backend\/server\/api\/([\w/-]+)";\s*$/;
    for (const [pattern, file] of wrappers) {
      const text = readFileSync(file, "utf8");
      const match = text.match(wrapperShape);
      expect(match, `${file} should only re-export backend handlers`).not.toBeNull();
      if (!match) continue;

      const entry = routes.find((r) => r.pattern === pattern);
      expect(entry, pattern).toBeDefined();
      const wrapperMethods = match[1].split(",").map((m) => m.trim());
      expect(wrapperMethods.sort(), pattern).toEqual(moduleMethods(entry!.module).sort());
    }
  });

  it("backend handlers do not import next", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts")) {
          if (/from "next\b|from 'next\b/.test(readFileSync(full, "utf8"))) offenders.push(full);
        }
      }
    };
    walk(BACKEND_API_DIR);
    expect(offenders).toEqual([]);
  });
});

describe("matchPath", () => {
  it("matches static patterns exactly", () => {
    expect(matchPath("/api/teams", "/api/teams")).toEqual({});
    expect(matchPath("/api/teams", "/api/team")).toBeNull();
    expect(matchPath("/api/teams", "/api/teams/extra")).toBeNull();
  });

  it("captures :params and decodes them", () => {
    expect(matchPath("/api/team/:id/trace", "/api/team/abc-123/trace")).toEqual({
      id: "abc-123",
    });
    expect(matchPath("/api/agent/:id", "/api/agent/a%20b")).toEqual({ id: "a b" });
  });

  it("rejects malformed percent-encoding instead of throwing", () => {
    expect(matchPath("/api/agent/:id", "/api/agent/%zz")).toBeNull();
  });

  it("does not confuse sibling routes", () => {
    expect(matchPath("/api/team/:id", "/api/team/abc/trace")).toBeNull();
    expect(matchPath("/api/team/:id/trace", "/api/team/abc")).toBeNull();
  });
});
