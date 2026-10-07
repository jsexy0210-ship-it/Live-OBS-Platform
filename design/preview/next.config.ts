import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  devIndicators: false,
  experimental: { externalDir: true },
};

export default nextConfig;
