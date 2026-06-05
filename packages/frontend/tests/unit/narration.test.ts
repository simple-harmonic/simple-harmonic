import { describe, expect, it } from "vitest";
import { describeAction, extractDetail } from "@/lib/narration";

// T8: tool action labels + the collapsible-output detail extraction.

describe("extractDetail", () => {
  it("returns the output string when present", () => {
    expect(extractDetail({ output: "hello stdout" })).toBe("hello stdout");
  });

  it("returns undefined when there is no output", () => {
    expect(extractDetail({ path: "x", bytes: 10 })).toBeUndefined();
  });

  it("returns undefined for an empty output string", () => {
    expect(extractDetail({ output: "" })).toBeUndefined();
  });

  it("ignores a non-string output", () => {
    expect(extractDetail({ output: 123 as unknown as string })).toBeUndefined();
  });
});

describe("describeAction — v0.1 tool labels", () => {
  it("labels file_read with path and bytes", () => {
    expect(describeAction("file_read", { path: "src/a.ts", bytes: 42 })).toContain("src/a.ts");
  });

  it("labels file_written with path and chars", () => {
    expect(describeAction("file_written", { path: "out.txt", chars: 9 })).toContain("out.txt");
  });

  it("labels command_run with command and args", () => {
    const s = describeAction("command_run", { command: "git", args: ["status"] });
    expect(s).toContain("git");
    expect(s).toContain("status");
  });

  it("labels http_fetched with url and status", () => {
    const s = describeAction("http_fetched", { url: "https://x.com", status: 200 });
    expect(s).toContain("https://x.com");
    expect(s).toContain("200");
  });

  it("labels github_api_called with method, path, status", () => {
    const s = describeAction("github_api_called", { method: "POST", path: "/repos/o/r/issues", status: 201 });
    expect(s).toContain("POST");
    expect(s).toContain("/repos/o/r/issues");
  });

  it("labels awaiting_approval", () => {
    expect(describeAction("awaiting_approval", {})).toContain("approval");
  });
});
