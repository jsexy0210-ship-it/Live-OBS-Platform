import type { Metadata } from "next";
import Link from "next/link";
import { CALCULATORS } from "@/lib/calculators";
import { CONTACT_EMAIL } from "@/lib/site";

export const metadata: Metadata = {
  title: "서비스 소개",
  description: "인생잔량 서비스 기준과 계산 원칙",
  alternates: { canonical: "/about/" },
  openGraph: { url: "/about/", title: "서비스 소개", description: "인생잔량 서비스 기준과 계산 원칙" }
};

export default function AboutPage() {
  return (
    <main className="pageShell docPage">
      <p className="eyebrow">ABOUT</p>
      <h1>서비스 소개</h1>

      <section>
        <h2>정의</h2>
        <p>인생잔량(LifeLeft) · 시간·돈·횟수의 남은 양과 써버린 양 계산 도구.</p>
        <p>회원가입·로그인 없음. 누구나 무료 이용.</p>
      </section>

      <section>
        <h2>계산기</h2>
        <ul>
          {CALCULATORS.map((item) => (
            <li key={item.href}>
              <Link href={item.href}>{item.title}</Link> · {item.summary}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <h2>결과 원칙</h2>
        <ul>
          <li>숫자 · 결론</li>
          <li>배지 · 숫자 기준 판정</li>
          <li>차트 · 수치 체감</li>
          <li>근거 · 계산식과 미반영 항목 명시</li>
        </ul>
      </section>

      <section>
        <h2>한계</h2>
        <ul>
          <li>모든 결과 · 사용자 입력 기반 추정치</li>
          <li>개인 실제 수명 예측 아님</li>
          <li>재무·투자 자문 아님</li>
          <li>공휴일·휴직·연봉 변동 등 일부 변수 미반영 · 각 계산기 &lsquo;계산 근거&rsquo;에 명시</li>
        </ul>
      </section>

      <section>
        <h2>운영</h2>
        <p>광고 수익 기반 무료 운영 · Google AdSense 광고 게재.</p>
        {CONTACT_EMAIL ? (
          <p>
            문의 · <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
          </p>
        ) : null}
      </section>
    </main>
  );
}
