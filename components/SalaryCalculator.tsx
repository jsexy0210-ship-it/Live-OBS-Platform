"use client";

import { useMemo, useState } from "react";
import { SalaryCumulativeChart } from "@/components/Charts";
import { ResultHero } from "@/components/ResultHero";
import { salaryBadge } from "@/lib/badges";

export function SalaryCalculator() {
  const [currentAge, setCurrentAge] = useState(36);
  const [careerStartAge, setCareerStartAge] = useState(25);
  const [retirementAge, setRetirementAge] = useState(60);
  const [monthlySalary, setMonthlySalary] = useState(4_000_000);

  const result = useMemo(() => {
    const start = Math.max(15, careerStartAge);
    const current = Math.max(start, currentAge);
    const retirement = Math.max(current, retirementAge);
    const totalMonths = Math.max(1, Math.round((retirement - start) * 12));
    const elapsedMonths = Math.min(totalMonths, Math.max(0, Math.round((current - start) * 12)));
    const remainingPays = Math.max(0, totalMonths - elapsedMonths);
    const remainingPercent = (remainingPays / totalMonths) * 100;
    const safeSalary = Math.max(0, monthlySalary);

    return {
      remainingPays,
      remainingPercent,
      futureTotal: remainingPays * safeSalary,
      annual: safeSalary * 12
    };
  }, [careerStartAge, currentAge, monthlySalary, retirementAge]);

  const badge = salaryBadge(result.remainingPercent);

  return (
    <div className="calculatorLayout">
      <section className="inputPanel">
        <p className="eyebrow">현재 급여 유지 가정</p>
        <h1>월급 잔량</h1>
        <div className="formGrid">
          <label><span>현재 나이</span><input type="number" min="15" max="100" value={currentAge} onChange={(event) => setCurrentAge(Number(event.target.value))} /></label>
          <label><span>직장 시작 나이</span><input type="number" min="15" max="100" value={careerStartAge} onChange={(event) => setCareerStartAge(Number(event.target.value))} /></label>
          <label><span>예상 은퇴 나이</span><input type="number" min="15" max="100" value={retirementAge} onChange={(event) => setRetirementAge(Number(event.target.value))} /></label>
          <label><span>현재 월 급여</span><input type="number" inputMode="numeric" min="0" value={monthlySalary} onChange={(event) => setMonthlySalary(Number(event.target.value))} /></label>
        </div>
      </section>

      <section className="resultPanel">
        <ResultHero
          value={`${result.remainingPays.toLocaleString()}회`}
          label="남은 월급"
          factBadge={badge.fact}
          impactBadge={badge.impact}
          tone={badge.tone}
        />
        <div className="metricGrid">
          <article><span>미래 급여 총액</span><strong>{result.futureTotal.toLocaleString()}원</strong></article>
          <article><span>연간 급여</span><strong>{result.annual.toLocaleString()}원</strong></article>
          <article><span>급여 잔량</span><strong>{result.remainingPercent.toFixed(1)}%</strong></article>
        </div>
        <SalaryCumulativeChart currentAge={currentAge} retirementAge={Math.max(currentAge, retirementAge)} monthlySalary={Math.max(0, monthlySalary)} />
        <details className="evidence">
          <summary>계산 근거</summary>
          <p>남은 급여 횟수 · 예상 은퇴 나이까지 월 1회 기준</p>
          <p>미래 급여 총액 · 현재 월 급여 × 남은 급여 횟수</p>
          <p>연봉 상승·성과급·퇴직금·세금 변동 미반영</p>
        </details>
      </section>
    </div>
  );
}
