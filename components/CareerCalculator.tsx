"use client";

import { useId, useMemo } from "react";
import { BirthField } from "@/components/BirthField";
import { FitText } from "@/components/FitText";
import { NumberField } from "@/components/fields";
import { InputNotice } from "@/components/InputNotice";
import { ResultHero } from "@/components/ResultHero";
import { ResultShare } from "@/components/ResultShare";
import { SourceNote } from "@/components/SourceNote";
import type { ResultBadge } from "@/lib/badges";
import { formatNumber, formatWon } from "@/lib/format";
import { useBirthProfile } from "@/lib/profile";
import { CAREER_SOURCE_LIST, ECONOMY, EMPLOYMENT, INDUSTRIES, wageGroupFor } from "@/lib/stats";
import { useStoredState } from "@/lib/useStoredState";

function careerBadge(diff: number): ResultBadge {
  const fact = `산업 평균 대비 ${diff > 0 ? "+" : ""}${diff}%`;
  if (diff >= 30) return { fact, impact: "산업 상위권 급여", tone: "neutral" };
  if (diff >= 0) return { fact, impact: "산업 평균 이상", tone: "neutral" };
  if (diff >= -10) return { fact, impact: "산업 평균 근접", tone: "watch" };
  if (diff >= -30) return { fact, impact: "산업 평균 미만", tone: "danger" };
  return { fact, impact: "산업 평균 크게 미만", tone: "critical" };
}

const signed = (value: number, digits = 0) => `${value > 0 ? "+" : ""}${formatNumber(value, digits)}`;
const toneOf = (value: number) => (value > 0 ? "neutral" : value < 0 ? "danger" : "watch");

export function CareerCalculator() {
  const selectId = useId();
  const { age } = useBirthProfile();
  const [industryKey, setIndustryKey] = useStoredState("lifeleft.career.industry", "manufacturing");
  const [monthlySalary, setMonthlySalary] = useStoredState("lifeleft.salary.monthlySalary", 4_000_000);

  const industry = INDUSTRIES.find((item) => item.key === industryKey) ?? INDUSTRIES[0];
  const employment = EMPLOYMENT[industry.employment];
  const invalidInput = monthlySalary <= 0;

  const result = useMemo(() => {
    const salary = Math.max(0, monthlySalary);
    const mine = salary / 10_000;
    const diff = Math.round(((mine - industry.wage2024) / industry.wage2024) * 100);
    const ageGroup = wageGroupFor(age);
    const ageDiff = Math.round(((mine - ageGroup.manwon) / ageGroup.manwon) * 100);
    const hourly = salary / ECONOMY.standardMonthlyHours;
    const minWageRatio = hourly / ECONOMY.minimumHourly2026;
    const rank = INDUSTRIES.filter((item) => item.wage2024 > mine).length + 1;
    const realValue10y = salary / Math.pow(1 + ECONOMY.cpi2025 / 100, 10);
    return { salary, mine, diff, ageGroup, ageDiff, hourly, minWageRatio, rank, realValue10y };
  }, [age, industry, monthlySalary]);

  const badge = careerBadge(result.diff);
  const resultValue = `${signed(result.diff)}%`;
  const maxWage = INDUSTRIES[0].wage2024;
  const mineRowIndex = result.rank - 1;

  return (
    <div className="calculatorLayout">
      <section className="inputPanel">
        <p className="eyebrow">공식 통계 기반</p>
        <h1>커리어 위치</h1>
        <div className="formGrid">
          <div className="field">
            <label htmlFor={selectId}>산업</label>
            <span className="selectWrap">
              <select id={selectId} value={industry.key} onChange={(event) => setIndustryKey(event.target.value)}>
                {INDUSTRIES.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </span>
          </div>
          <NumberField label="현재 월 급여(세전)" value={monthlySalary} onChange={setMonthlySalary} unit="원" money />
          <BirthField />
        </div>
        <InputNotice active={invalidInput} text="월 급여 입력 필요" />
        <p className="panelNote">
          산업 평균 · 2024년 임금근로일자리 월평균 세전 보수
          <br />
          월 급여 · 월급 잔량 계산기와 공유
        </p>
      </section>

      <section className="resultPanel">
        <ResultHero value={resultValue} label={`${industry.label} 평균 대비 월급 위치`} factBadge={badge.fact} impactBadge={badge.impact} tone={badge.tone} />
        <ResultShare title="커리어 위치" value={resultValue} factBadge={badge.fact} impactBadge={badge.impact} tone={badge.tone} />

        <div className="metricGrid">
          <article><span>{industry.label} 평균</span><strong><FitText>{formatNumber(industry.wage2024)}만원</FitText></strong></article>
          <article><span>{result.ageGroup.label} 평균 대비</span><strong><FitText>{signed(result.ageDiff)}%</FitText></strong></article>
          <article><span>시급 환산 · 최저임금 대비</span><strong><FitText>{formatNumber(Math.round(result.hourly))}원 · {formatNumber(result.minWageRatio, 1)}배</FitText></strong></article>
        </div>

        <section className="peerSection" aria-labelledby="industry-rank-title">
          <div className="scenarioHead">
            <h3 id="industry-rank-title">산업별 평균 월급 순위</h3>
            <span>내 월급 · 20개 산업 중 {result.rank}위 수준</span>
          </div>
          <ol className="rankList compact">
            {INDUSTRIES.map((item, index) => (
              <FragmentRow key={item.key} showMine={index === mineRowIndex} mine={result.mine} maxWage={maxWage}>
                <li data-tone={item.key === industry.key ? "neutral" : undefined} className={item.key === industry.key ? "selected" : undefined}>
                  <span className="rankNo">{String(index + 1).padStart(2, "0")}</span>
                  <span className="rankBody">
                    <span className="rankTop">
                      <strong>{item.label}{item.key === industry.key ? " · 선택" : ""}</strong>
                      <span className="rankValue">{formatNumber(item.wage2024)}만원</span>
                    </span>
                    <span className="meter" aria-hidden="true">
                      <span style={{ width: `${(item.wage2024 / maxWage) * 100}%` }} />
                    </span>
                  </span>
                </li>
              </FragmentRow>
            ))}
            {mineRowIndex >= INDUSTRIES.length ? <MineRow mine={result.mine} maxWage={maxWage} /> : null}
          </ol>
        </section>

        <section className="peerSection" aria-labelledby="employment-title">
          <div className="scenarioHead">
            <h3 id="employment-title">산업 고용 흐름</h3>
            <span>취업자 수 · 최근 흐름, 전망 아님</span>
          </div>
          <div className="metricGrid flowGrid">
            <article data-tone={toneOf(employment.annualDiff)}>
              <span>2025년 연간 · 전년 대비</span>
              <strong className="toneText"><FitText>{signed(employment.annualDiff)}천명 ({signed(employment.annualRate, 1)}%)</FitText></strong>
              <small>취업자 {formatNumber(employment.annual)}천명</small>
            </article>
            <article data-tone={toneOf(employment.monthDiff)}>
              <span>2026년 8월 · 전년 동월 대비</span>
              <strong className="toneText"><FitText>{signed(employment.monthDiff)}천명 ({signed(employment.monthRate, 1)}%)</FitText></strong>
              <small>취업자 {formatNumber(employment.month)}천명</small>
            </article>
          </div>
          <p className="flowNote">집계 분류 · {employment.label}</p>
        </section>

        <section className="peerSection" aria-labelledby="economy-title">
          <div className="scenarioHead">
            <h3 id="economy-title">경제지표</h3>
            <span>공식 발표 기준</span>
          </div>
          <div className="metricGrid econGrid">
            <article><span>2026 최저임금</span><strong><FitText>{formatNumber(ECONOMY.minimumHourly2026)}원</FitText></strong><small>전년 대비 +{ECONOMY.minimumGrowth2026}% · 월 {formatWon(ECONOMY.minimumMonthly2026)}</small></article>
            <article><span>소비자물가 상승률</span><strong><FitText>{ECONOMY.cpi2025}%</FitText></strong><small>2025 연간 · 2026.8 {ECONOMY.cpi202608}%</small></article>
            <article><span>실질 GDP 성장률</span><strong><FitText>{ECONOMY.gdp2025}%</FitText></strong><small>2025 연간 잠정</small></article>
            <article><span>10년 뒤 현재 월급 실질 가치</span><strong><FitText>{formatWon(result.realValue10y)}</FitText></strong><small>물가 {ECONOMY.cpi2025}% 지속 가정</small></article>
          </div>
        </section>

        <details className="evidence">
          <summary>계산 근거</summary>
          <p>산업 평균 대비 · (월 급여 − 산업 월평균 보수) ÷ 산업 월평균 보수</p>
          <p>시급 환산 · 월 급여 ÷ 209시간(주 40시간 월 환산 기준)</p>
          <p>실질 가치 · 월 급여 ÷ (1 + 2025년 물가상승률)^10</p>
          <p>산업 평균 · 세전 보수, 직급·경력·기업 규모 미반영</p>
          <p>고용 흐름 · 과거 공식 집계, 산업 전망·직무 위험도 아님</p>
        </details>
        <SourceNote sources={CAREER_SOURCE_LIST} />
      </section>
    </div>
  );
}

function MineRow({ mine, maxWage }: { mine: number; maxWage: number }) {
  return (
    <li className="mineRow" data-tone="watch">
      <span className="rankNo">나</span>
      <span className="rankBody">
        <span className="rankTop">
          <strong>내 월급</strong>
          <span className="rankValue">{formatNumber(Math.round(mine))}만원</span>
        </span>
        <span className="meter" aria-hidden="true">
          <span style={{ width: `${Math.min(100, (mine / maxWage) * 100)}%` }} />
        </span>
      </span>
    </li>
  );
}

function FragmentRow({ children, showMine, mine, maxWage }: { children: React.ReactNode; showMine: boolean; mine: number; maxWage: number }) {
  return (
    <>
      {showMine ? <MineRow mine={mine} maxWage={maxWage} /> : null}
      {children}
    </>
  );
}
