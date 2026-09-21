import type { Metadata, Viewport } from "next";
import Link from "next/link";
import { ADSENSE_CLIENT } from "@/lib/ads";
import { ogImages } from "@/lib/og";
import { SiteNav } from "@/components/SiteNav";
import { BUSINESS, CONTACT_EMAIL, SITE_NAME, SITE_URL } from "@/lib/site";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "인생잔량 | LifeLeft",
    template: "%s | 인생잔량"
  },
  description: "시간·돈·횟수의 잔량 계산",
  alternates: {
    canonical: "/"
  },
  openGraph: {
    type: "website",
    locale: "ko_KR",
    url: "/",
    siteName: SITE_NAME,
    title: "인생잔량 | LifeLeft",
    description: "시간·돈·횟수의 잔량 계산",
    images: ogImages("home")
  },
  twitter: {
    card: "summary_large_image",
    title: "인생잔량 | LifeLeft",
    description: "시간·돈·횟수의 잔량 계산",
    images: ogImages("home")
  },
  other: {
    "google-adsense-account": ADSENSE_CLIENT
  }
};

export const viewport: Viewport = {
  themeColor: "#0A0B0E"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;700;800&display=swap"
        />
        <link
          rel="stylesheet"
          href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css"
        />
        <script
          async
          src={`https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${ADSENSE_CLIENT}`}
          crossOrigin="anonymous"
        />
      </head>
      <body>
        <header className="siteHeader">
          <div className="headerInner">
            <Link className="brand" href="/">
              <span className="brandMark" aria-hidden="true" />
              LIFELEFT
            </Link>
            <SiteNav />
          </div>
        </header>
        {children}
        <footer className="siteFooter">
          <div className="footerTop">
            <div>
              <strong className="footerBrand">LIFELEFT · 인생잔량</strong>
              <p>숫자 우선 · 사실 명시 · 판단 최소화</p>
            </div>
            <nav aria-label="사이트 정보">
              <Link href="/about/">서비스 소개</Link>
              <Link href="/privacy/">개인정보처리방침</Link>
            </nav>
          </div>
          <address className="businessInfo">
            <span>상호 {BUSINESS.name}</span>
            <span>대표 {BUSINESS.representative}</span>
            <span>사업자등록번호 {BUSINESS.registrationNumber}</span>
            <span>업태·종목 {BUSINESS.category}</span>
            <span>
              문의 <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
            </span>
          </address>
          <p className="footerNote">
            모든 결과는 입력값 기반 추정치. 개인 실제 수명·재무 상태 판정 아님. 입력값은 현재 브라우저에만 저장.
          </p>
        </footer>
      </body>
    </html>
  );
}
