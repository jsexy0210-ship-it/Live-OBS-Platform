import type { NextConfig } from "next";
import { HTML_LIMITED_BOTS } from "./lib/shareCrawlers";

const nextConfig: NextConfig = {
  // 서버 배포용 이미지(Dockerfile)가 .next/standalone만 복사해 node server.js로 띄운다.
  output: "standalone",
  // 공유 미리보기 크롤러에는 메타데이터를 <head> 안에 고정한다(Next 기본 목록 + 카카오톡·다음 등, lib/shareCrawlers.ts)
  htmlLimitedBots: HTML_LIMITED_BOTS,
};

export default nextConfig;
