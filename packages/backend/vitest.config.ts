import { resolve } from "node:path";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: {
      "@/": resolve(__dirname, "src") + "/",
      "@simple-harmonic/backend/": resolve(__dirname, "src") + "/",
      "@simple-harmonic/frontend/": resolve(__dirname, "../frontend/src") + "/",
    },
  },
  test: {
    name: "backend",
    root: __dirname,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
