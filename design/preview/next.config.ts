import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  agentRules: false,
  experimental: { externalDir: true },
};

export default nextConfig;
