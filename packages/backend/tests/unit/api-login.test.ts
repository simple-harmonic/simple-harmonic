import { afterEach, describe, expect, it } from "vitest";

const savedPw = process.env.OPERATOR_PASSWORD;
afterEach(() => {
  if (savedPw === undefined) delete process.env.OPERATOR_PASSWORD;
  else process.env.OPERATOR_PASSWORD = savedPw;
});

function loginReq(body: unknown): Request {
  return new Request("http://localhost/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/login", () => {
  it("returns 503 when OPERATOR_PASSWORD is not configured", async () => {
    delete process.env.OPERATOR_PASSWORD;
    const { POST } = await import("@/server/api/login");
    const res = await POST(loginReq({ password: "x" }));
    expect(res.status).toBe(503);
  });

  it("returns 401 for a wrong password", async () => {
    process.env.OPERATOR_PASSWORD = "correct-horse-battery";
    const { POST } = await import("@/server/api/login");
    const res = await POST(loginReq({ password: "wrong" }));
    expect(res.status).toBe(401);
  });

  it("sets an httpOnly sh_operator cookie on the correct password", async () => {
    process.env.OPERATOR_PASSWORD = "correct-horse-battery";
    const { POST } = await import("@/server/api/login");
    const res = await POST(loginReq({ password: "correct-horse-battery" }));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie") || "";
    expect(setCookie).toContain("sh_operator=");
    expect(setCookie.toLowerCase()).toContain("httponly");
  });
});
