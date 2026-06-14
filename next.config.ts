import type { NextConfig } from "next";

// Cutover hook for the Python (FastAPI) backend port — see backend-py/.
// When PY_BACKEND_URL is set (e.g. http://localhost:3001), every /api/* request
// is forwarded to the Python backend instead of the in-repo Next route handlers.
// Unset (the default) => behavior is unchanged; the TypeScript Next routes serve.
// `beforeFiles` makes the rewrite take precedence over the filesystem API routes.
const PY_BACKEND_URL = process.env.PY_BACKEND_URL;

const nextConfig: NextConfig = {
  // Hide the floating "N" Next.js Dev Tools indicator in dev. Errors still
  // surface in the terminal and via the error overlay; we just don't want
  // the persistent button on every page.
  devIndicators: false,

  ...(PY_BACKEND_URL
    ? {
        async rewrites() {
          return {
            beforeFiles: [
              { source: "/api/:path*", destination: `${PY_BACKEND_URL}/api/:path*` },
            ],
            afterFiles: [],
            fallback: [],
          };
        },
      }
    : {}),
};

export default nextConfig;
