import type { Metadata } from "next";
import Link from "next/link";
import { SITE_NAME, SITE_URL } from "@/lib/site";
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
    description: "시간·돈·횟수의 잔량 계산"
  }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>
        <header className="siteHeader">
          <Link className="brand" href="/">LIFELEFT</Link>
          <nav>
            <Link href="/commute/">출근</Link>
            <Link href="/salary/">월급</Link>
            <Link href="/weekends/">주말</Link>
            <Link href="/work-time/">회사시간</Link>
            <Link href="/subscriptions/">구독</Link>
            <Link href="/survival/">생존</Link>
          </nav>
        </header>
        {children}
        <footer className="siteFooter">
          <strong>LIFELEFT</strong>
          <span>숫자 우선 · 사실 명시 · 판단 최소화</span>
        </footer>
      </body>
    </html>
  );
}
