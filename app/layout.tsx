import type { Metadata } from "next";
import "../styles/wanted-sans.css";

export const metadata: Metadata = {
  title: "Live OBS Platform",
  description: "판매자 쇼핑몰·라이브 방송 운영 구독 플랫폼 (개발 중)",
  robots: { index: false, follow: false }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <head>
        {/* 원티드 산스: 기본 라틴(split.90)·자주 쓰는 한글(split.88)만 미리 받고 나머지는 화면에 쓰인 글자만 받는다(styles/wanted-sans.css) */}
        <link rel="preload" href="/fonts/wanted-sans/split/WantedSansVariable.split.90.woff2" as="font" type="font/woff2" crossOrigin="" />
        <link rel="preload" href="/fonts/wanted-sans/split/WantedSansVariable.split.88.woff2" as="font" type="font/woff2" crossOrigin="" />
      </head>
      <body>{children}</body>
    </html>
  );
}
