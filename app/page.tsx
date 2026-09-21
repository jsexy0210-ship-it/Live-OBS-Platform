import Link from "next/link";
import { AdSlot } from "@/components/AdSlot";
import { JobExposure } from "@/components/JobExposure";
import { BurnLine, DepletionDonut, LifeGrid, SpendBars } from "@/components/Charts";
import { QuickLife } from "@/components/QuickLife";
import { ResultHero } from "@/components/ResultHero";
import { depletionBadge } from "@/lib/badges";
import { CALCULATORS, CATEGORY_CODE, CATEGORY_ORDER } from "@/lib/calculators";

const badge = depletionBadge(18);

export default function Home() {
  return (
    <main>
      <section className="hero">
        <div className="heroHead">
          <p className="eyebrow">LIFE BALANCE / 2026</p>
          <h1>인생잔량</h1>
          <p className="heroSub">남은 인생잔량을 확인하세요</p>
        </div>
        <QuickLife />
      </section>

      <JobExposure variant="home" />

      <AdSlot slot="homeMiddle" />

      <section className="catalogSection" aria-labelledby="catalog-title">
        <div className="sectionHeading">
          <p className="sectionKicker">CALCULATORS · {CALCULATORS.length}</p>
          <h2 id="catalog-title">잔량 목록</h2>
        </div>
        {CATEGORY_ORDER.map((category) => (
          <div className="catalogGroup" key={category}>
            <p className="catalogGroupHead">
              <span>{CATEGORY_CODE[category]}</span>
              <strong>{category}</strong>
            </p>
            <div className="catalogGrid">
              {CALCULATORS.filter((item) => item.category === category).map((item) => (
                <Link className="catalogCard" href={item.href} key={item.href}>
                  <strong>{item.title}</strong>
                  <small>{item.summary}</small>
                  <span className="cardFoot">
                    <span>단위 · {item.unit}</span>
                    <span className="cardArrow" aria-hidden="true">→</span>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="previewSection" aria-labelledby="preview-title">
        <div className="sectionHeading">
          <p className="sectionKicker">RESULT FORMAT</p>
          <h2 id="preview-title">결과 구조</h2>
        </div>
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

      <section className="principles" aria-label="결과 원칙">
        <article><span>01</span><strong>숫자</strong><small>결론</small></article>
        <article><span>02</span><strong>배지</strong><small>판정</small></article>
        <article><span>03</span><strong>차트</strong><small>체감</small></article>
        <article><span>04</span><strong>근거</strong><small>신뢰</small></article>
      </section>

      <AdSlot slot="homeBottom" />
    </main>
  );
}
