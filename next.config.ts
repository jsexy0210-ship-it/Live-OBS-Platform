import type { NextConfig } from "next";
import { HTML_LIMITED_BOTS } from "./lib/shareCrawlers";

const nextConfig: NextConfig = {
  // 서버 배포용 이미지(Dockerfile)가 .next/standalone만 복사해 node server.js로 띄운다.
  output: "standalone",
  // 공유 미리보기 크롤러에는 메타데이터를 <head> 안에 고정한다(Next 기본 목록 + 카카오톡·다음 등, lib/shareCrawlers.ts)
  htmlLimitedBots: HTML_LIMITED_BOTS,
  // 메뉴 통합(DS-NAV 확정 구조, 2026-10-06)으로 사라진 화면의 옛 주소를 새 화면으로 보낸다(북마크·알림·메일 링크가 끊기지 않게).
  // 화면을 새 주소로 옮기는 PR이 병합될 때 그 PR이 한 줄씩 더한다(미리 걸면 옛 화면이 사라진다). 임시(307) 이동으로 둔다.
  async redirects() {
    return [
      // 공유 설정은 쇼핑몰 정보(SA-060) 한 화면에 들어갔다
      { source: "/seller/settings/share", destination: "/seller/settings/shop", permanent: false },
    ] as { source: string; destination: string; permanent: boolean }[];
  },
};

export default nextConfig;
