"use client";

import { useMemo, useState } from "react";
import { CashRunwayChart } from "@/components/Charts";
import { ResultHero } from "@/components/ResultHero";
import { survivalBadge } from "@/lib/badges";

export function SurvivalCalculator() {
  const [cash, setCash] = useState(20_000_000);
  const [fixed, setFixed] = useState(1_500_000);
  const [variable, setVariable] = useState(800_000);
  const [income, setIncome] = useState(0);

  const result = useMemo(() => {
    const expense = Math.max(0, fixed) + Math.max(0, variable);
    const burn = Math.max(0, expense - Math.max(0, income));
    const months = burn > 0 ? Math.max(0, cash) / burn : Number.POSITIVE_INFINITY;
    return { expense, burn, months };
  }, [cash, fixed, variable, income]);

  const badge = survivalBadge(result.months);
  const displayMonths = Number.isFinite(result.months)
    ? `${result.months.toFixed(1)}개월`
    : "유지";

  return (
    <div className="calculatorLayout">
      <section className="inputPanel">
        <p className="eyebrow">사용자 입력 기반</p>
        <h1>생존 잔량</h1>

        <div className="formGrid">
          <label>
            <span>가용 현금</span>
            <input
              type="number"
              inputMode="numeric"
              value={cash}
              onChange={(event) => setCash(Number(event.target.value))}
            />
          </label>
          <label>
            <span>월 고정지출</span>
            <input
              type="number"
              inputMode="numeric"
              value={fixed}
              onChange={(event) => setFixed(Number(event.target.value))}
            />
          </label>
          <label>
            <span>월 변동지출</span>
            <input
              type="number"
              inputMode="numeric"
              value={variable}
              onChange={(event) => setVariable(Number(event.target.value))}
            />
          </label>
          <label>
            <span>월 정기수입</span>
            <input
              type="number"
              inputMode="numeric"
              value={income}
              onChange={(event) => setIncome(Number(event.target.value))}
            />
          </label>
        </div>
      </section>

      <section className="resultPanel">
        <ResultHero
          value={displayMonths}
          label="소득 중단 시 생존기간"
          factBadge={badge.fact}
          impactBadge={badge.impact}
          tone={badge.tone}
        />

        <div className="metricGrid">
          <article><span>월 총지출</span><strong>{result.expense.toLocaleString()}원</strong></article>
          <article><span>월 순소모</span><strong>{result.burn.toLocaleString()}원</strong></article>
          <article><span>가용 현금</span><strong>{Math.max(0, cash).toLocaleString()}원</strong></article>
        </div>

        <CashRunwayChart
          cash={Math.max(0, cash)}
          monthlyBurn={result.burn}
          months={result.months}
        />

        <details className="evidence">
          <summary>계산 근거</summary>
          <p>가용 현금 ÷ 월 순소모</p>
          <p>월 순소모 · 총지출 - 정기수입</p>
          <p>투자수익·이자·물가 변동 미반영</p>
        </details>
      </section>
    </div>
  );
}
