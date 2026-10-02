import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Live OBS Platform",
  description: "판매자 쇼핑몰·라이브 방송 운영 구독 플랫폼 (개발 중)",
  robots: { index: false, follow: false }
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
