import { afterEach, describe, expect, it } from "vitest";
import {
  OPERATOR_COOKIE,
  constantTimeEqual,
  isCronAuthorized,
  isOperatorAuthorized,
  sha256Hex,
} from "../../src/server/operator-auth";

function req(headers: Record<string, string>): Request {
  return new Request("http://localhost/x", { headers });
}

describe("operator-auth", () => {
  const savedVercel = process.env.VERCEL;
  afterEach(() => {
    if (savedVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = savedVercel;
  });

  it("sha256Hex matches the known digest of 'abc'", async () => {
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("constantTimeEqual compares value and length", () => {
    expect(constantTimeEqual("abc", "abc")).toBe(true);
    expect(constantTimeEqual("abc", "abd")).toBe(false);
    expect(constantTimeEqual("abc", "ab")).toBe(false);
  });

  describe("isOperatorAuthorized", () => {
    const PW = "s3cret-operator";

    it("accepts a correct Bearer password", async () => {
      expect(
        await isOperatorAuthorized(req({ authorization: `Bearer ${PW}` }), PW),
      ).toBe(true);
    });

    it("rejects a wrong Bearer password", async () => {
      expect(
        await isOperatorAuthorized(req({ authorization: "Bearer nope" }), PW),
      ).toBe(false);
    });

    it("accepts the sh_operator cookie = sha256(password)", async () => {
      const cookie = `${OPERATOR_COOKIE}=${await sha256Hex(PW)}`;
      expect(await isOperatorAuthorized(req({ cookie }), PW)).toBe(true);
    });

    it("rejects a wrong cookie and no-auth", async () => {
      expect(
        await isOperatorAuthorized(req({ cookie: `${OPERATOR_COOKIE}=deadbeef` }), PW),
      ).toBe(false);
      expect(await isOperatorAuthorized(req({}), PW)).toBe(false);
    });
  });

  describe("isCronAuthorized", () => {
    it("accepts the x-vercel-cron header", () => {
      expect(isCronAuthorized(req({ "x-vercel-cron": "1" }), "secret")).toBe(true);
    });

    it("accepts a matching Bearer CRON_SECRET, rejects a wrong one", () => {
      expect(isCronAuthorized(req({ authorization: "Bearer secret" }), "secret")).toBe(true);
      expect(isCronAuthorized(req({ authorization: "Bearer wrong" }), "secret")).toBe(false);
    });

    it("with no secret set: allows in dev, fails closed in production", () => {
      delete process.env.VERCEL;
      expect(isCronAuthorized(req({}), undefined)).toBe(true);
      process.env.VERCEL = "1";
      expect(isCronAuthorized(req({}), undefined)).toBe(false);
    });
  });
});
