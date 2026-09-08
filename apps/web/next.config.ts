import type { NextConfig } from "next";

const defaultApiUpstream = "http://127.0.0.1:4000";

export function resolveApiUpstream(input = process.env.ORIGINPOST_API_UPSTREAM): string {
  const candidate = input?.trim() || defaultApiUpstream;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("ORIGINPOST_API_UPSTREAM must be an absolute HTTP or HTTPS origin.");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("ORIGINPOST_API_UPSTREAM must be an origin-only HTTP or HTTPS URL without credentials, a path, query, or fragment.");
  }
  return url.origin;
}

const apiUpstream = resolveApiUpstream();

const config: NextConfig = {
  reactStrictMode: true,
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  transpilePackages: ["@originpost/domain"],
  agentRules: false,
  async rewrites() {
    return [
      { source: "/v1/:path*", destination: `${apiUpstream}/v1/:path*` },
      { source: "/public/v1/:path*", destination: `${apiUpstream}/public/v1/:path*` },
    ];
  },
  async headers() {
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/offline.html",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
      {
        source: "/invite",
        headers: [
          { key: "Cache-Control", value: "no-store" },
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default config;
