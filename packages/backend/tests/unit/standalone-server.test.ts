import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPERATOR_COOKIE, sha256Hex } from "../../src/server/operator-auth";
import { createBackendServer } from "../../src/server/standalone/server";

// ---------------------------------------------------------------------------
// Smoke tests for the standalone HTTP host: node:http bridge, operator gate
// (mirroring src/proxy.ts), dispatch, 404/405 handling. DB-free endpoints
// only — these tests must pass without PostgreSQL.
// ---------------------------------------------------------------------------

const PASSWORD = "standalone-test-password";

let server: Server;
let base: string;
const savedEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ["OPERATOR_PASSWORD", "VERCEL"]) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.OPERATOR_PASSWORD = PASSWORD;

  server = createBackendServer();
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  base = `http://localhost:${address.port}`;
});

afterAll(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe("standalone server", () => {
  it("serves a banner at / without leaking the endpoint list", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { mode: string; endpoints?: string[] };
    expect(body.mode).toBe("standalone");
    expect(body.endpoints).toBeUndefined();
  });

  it("gates /api/* behind the operator password", async () => {
    const res = await fetch(`${base}/api/settings`);
    expect(res.status).toBe(401);
  });

  it("rejects a bad login and accepts the real password with a session cookie", async () => {
    const bad = await fetch(`${base}/api/login`, {
      method: "POST",
      body: JSON.stringify({ password: "wrong" }),
    });
    expect(bad.status).toBe(401);

    const good = await fetch(`${base}/api/login`, {
      method: "POST",
      body: JSON.stringify({ password: PASSWORD }),
    });
    expect(good.status).toBe(200);
    const cookie = good.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${OPERATOR_COOKIE}=${await sha256Hex(PASSWORD)}`);
    expect(cookie).toContain("HttpOnly");
  });

  it("admits requests carrying the session cookie", async () => {
    const cookie = `${OPERATOR_COOKIE}=${await sha256Hex(PASSWORD)}`;
    const res = await fetch(`${base}/api/settings`, { headers: { cookie } });
    expect(res.status).toBe(200);
  });

  it("admits requests with a bearer operator password", async () => {
    const res = await fetch(`${base}/api/settings`, {
      headers: { authorization: `Bearer ${PASSWORD}` },
    });
    expect(res.status).toBe(200);
  });

  it("404s unknown API paths (authorized)", async () => {
    const res = await fetch(`${base}/api/does-not-exist`, {
      headers: { authorization: `Bearer ${PASSWORD}` },
    });
    expect(res.status).toBe(404);
  });

  it("405s known paths with the wrong method, with an Allow header", async () => {
    const res = await fetch(`${base}/api/login`);
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, OPTIONS");
  });

  it("serves HEAD through the GET handler with an empty body", async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: "HEAD",
      headers: { authorization: `Bearer ${PASSWORD}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("answers OPTIONS with the allowed methods", async () => {
    const res = await fetch(`${base}/api/settings`, {
      method: "OPTIONS",
      headers: { authorization: `Bearer ${PASSWORD}` },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("allow")).toBe("GET, POST, OPTIONS, HEAD");
  });

  it("404s malformed percent-encoding in path params instead of 500", async () => {
    const res = await fetch(`${base}/api/team/%zz`, {
      headers: { authorization: `Bearer ${PASSWORD}` },
    });
    expect(res.status).toBe(404);
  });
});
