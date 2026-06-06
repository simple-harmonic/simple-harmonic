import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "a2ax",
    root: __dirname,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
