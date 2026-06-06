import { describe, expect, it } from "vitest";
import { validateContract } from "@/lib/meta-agent/contract";

describe("validateContract", () => {
  const bugContract = {
    type: "object",
    required: ["bugs"],
    properties: {
      bugs: {
        type: "array",
        items: {
          type: "object",
          required: ["file", "description", "severity"],
          properties: {
            file: { type: "string" },
            description: { type: "string" },
            severity: { type: "string" },
            line: { type: "number" },
          },
        },
      },
    },
  };

  it("passes valid payload", () => {
    const payload = {
      bugs: [
        { file: "src/app.ts", description: "null ref", severity: "high", line: 42 },
      ],
    };
    const result = validateContract(payload, bugContract);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it("fails when required field is missing at root", () => {
    const result = validateContract({}, bugContract);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].path).toBe("bugs");
    expect(result.issues[0].message).toContain("required");
  });

  it("fails when required field is missing in array item", () => {
    const payload = {
      bugs: [
        { file: "src/app.ts", description: "null ref" },
      ],
    };
    const result = validateContract(payload, bugContract);
    expect(result.valid).toBe(false);
    const severityIssue = result.issues.find((i) => i.path.includes("severity"));
    expect(severityIssue).toBeDefined();
    expect(severityIssue!.message).toContain("required");
  });

  it("fails on wrong type", () => {
    const payload = {
      bugs: "not an array",
    };
    const result = validateContract(payload, bugContract);
    expect(result.valid).toBe(false);
    expect(result.issues[0].message).toContain("expected array");
  });

  it("fails on wrong nested type", () => {
    const payload = {
      bugs: [
        { file: 123, description: "ok", severity: "high" },
      ],
    };
    const result = validateContract(payload, bugContract);
    expect(result.valid).toBe(false);
    expect(result.issues[0].path).toBe("bugs[0].file");
    expect(result.issues[0].message).toContain("expected string");
  });

  it("passes with empty array", () => {
    const result = validateContract({ bugs: [] }, bugContract);
    expect(result.valid).toBe(true);
  });

  it("passes with no contract (empty schema)", () => {
    const result = validateContract({ anything: true }, {});
    expect(result.valid).toBe(true);
  });

  it("validates root type mismatch", () => {
    const result = validateContract("a string", bugContract);
    expect(result.valid).toBe(false);
    expect(result.issues[0].message).toContain("expected object");
  });

  it("validates multiple items in array", () => {
    const payload = {
      bugs: [
        { file: "a.ts", description: "ok", severity: "low" },
        { file: "b.ts", description: "broken" },
      ],
    };
    const result = validateContract(payload, bugContract);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].path).toBe("bugs[1].severity");
  });

  const testReportContract = {
    type: "object",
    required: ["passed", "failed"],
    properties: {
      passed: { type: "number" },
      failed: { type: "number" },
      failures: {
        type: "array",
        items: {
          type: "object",
          required: ["test", "error"],
          properties: {
            test: { type: "string" },
            error: { type: "string" },
          },
        },
      },
    },
  };

  it("validates a test report contract", () => {
    const payload = { passed: 10, failed: 1, failures: [{ test: "login", error: "timeout" }] };
    expect(validateContract(payload, testReportContract).valid).toBe(true);
  });

  it("catches missing test report fields", () => {
    const payload = { passed: 10 };
    const result = validateContract(payload, testReportContract);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => i.path === "failed")).toBe(true);
  });

  it("handles null values", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    const result = validateContract({ name: null }, schema);
    expect(result.valid).toBe(false);
    expect(result.issues[0].message).toContain("expected string, got null");
  });

  it("handles union types", () => {
    const schema = { type: "object", properties: { value: { type: ["string", "null"] } } };
    expect(validateContract({ value: "hello" }, schema).valid).toBe(true);
    expect(validateContract({ value: null }, schema).valid).toBe(true);
    expect(validateContract({ value: 42 }, schema).valid).toBe(false);
  });
});
