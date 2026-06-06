import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [react()],
  resolve: {
    alias: {
      "@/": resolve(__dirname, "src") + "/",
      "@simple-harmonic/backend/": resolve(__dirname, "../backend/src") + "/",
      "@simple-harmonic/frontend/": resolve(__dirname, "src") + "/",
    },
  },
  test: {
    name: "frontend",
    root: __dirname,
    environment: "jsdom",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
