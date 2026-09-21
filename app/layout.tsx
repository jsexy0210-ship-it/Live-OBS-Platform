import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "인생잔량 | LifeLeft",
  description: "시간·돈·횟수의 잔량 계산"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>
        <header className="siteHeader">
          <Link className="brand" href="/">LIFELEFT</Link>
          <nav>
            <Link href="/subscriptions/">구독 누적</Link>
            <Link href="/survival/">생존 잔량</Link>
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
