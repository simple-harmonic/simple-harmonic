import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/a2ax",
      "packages/backend",
      "packages/frontend",
    ],
  },
});
