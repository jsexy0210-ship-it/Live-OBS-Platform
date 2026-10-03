import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // 서버 배포용 이미지(Dockerfile)가 .next/standalone만 복사해 node server.js로 띄운다.
  output: "standalone",
};

export default nextConfig;
