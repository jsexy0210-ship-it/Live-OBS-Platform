import Link from "next/link";
import { BurnLine, DepletionDonut, LifeGrid, SpendBars } from "@/components/Charts";
import { ResultHero } from "@/components/ResultHero";
import { depletionBadge } from "@/lib/badges";

const badge = depletionBadge(18);

const calculators = [
  { href: "/commute/", title: "출근 잔량", metric: "횟수", status: "사용 가능" },
  { href: "/salary/", title: "월급 잔량", metric: "횟수", status: "사용 가능" },
  { href: "/weekends/", title: "주말 잔량", metric: "횟수", status: "사용 가능" },
  { href: "/work-time/", title: "회사 누적시간", metric: "시간", status: "사용 가능" },
  { href: "/subscriptions/", title: "구독 누적", metric: "돈", status: "사용 가능" },
  { href: "/survival/", title: "생존 잔량", metric: "돈", status: "사용 가능" }
];

export default function Home() {
  return (
    <main>
      <section className="hero">
        <div>
          <p className="eyebrow">LIFE BALANCE / 2026</p>
          <h1>인생잔량</h1>
          <p className="heroSub">시간 · 돈 · 횟수</p>
        </div>
        <div className="heroStatus">
          <span>현재 상태판</span>
          <strong>잔량 계산</strong>
        </div>
      </section>

      <section className="previewSection">
        <p className="sectionKicker">예시 결과</p>
        <ResultHero
          value="4,218회"
          label="남은 출근"
          factBadge={badge.fact}
          impactBadge="퇴직 가시권"
          tone={badge.tone}
          eyebrow="예시 데이터"
        />
        <div className="chartGrid">
          <DepletionDonut used={82} remaining={18} />
          <BurnLine />
          <SpendBars />
          <LifeGrid used={37} />
        </div>
      </section>

      <section className="calculatorSection">
        <div className="sectionHeading">
          <p className="sectionKicker">CALCULATORS</p>
          <h2>잔량 목록</h2>
        </div>
        <div className="calculatorGrid">
          {calculators.map((item) => (
            <Link className="calculatorCard" href={item.href} key={item.title}>
              <span>{item.metric}</span>
              <strong>{item.title}</strong>
              <small>{item.status}</small>
            </Link>
          ))}
        </div>
      </section>

      <section className="principles">
        <article><span>01</span><strong>숫자</strong><small>결론</small></article>
        <article><span>02</span><strong>배지</strong><small>판정</small></article>
        <article><span>03</span><strong>차트</strong><small>체감</small></article>
        <article><span>04</span><strong>근거</strong><small>신뢰</small></article>
      </section>
    </main>
  );
}
