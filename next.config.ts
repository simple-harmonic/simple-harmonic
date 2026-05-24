import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Hide the floating "N" Next.js Dev Tools indicator in dev. Errors still
  // surface in the terminal and via the error overlay; we just don't want
  // the persistent button on every page.
  devIndicators: false,
};

export default nextConfig;
