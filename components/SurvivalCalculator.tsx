"use client";

import { useMemo } from "react";
import { CashRunwayChart } from "@/components/Charts";
import { InputNotice } from "@/components/InputNotice";
import { ResultHero } from "@/components/ResultHero";
import { ResultShare } from "@/components/ResultShare";
import { survivalBadge } from "@/lib/badges";
import { useStoredState } from "@/lib/useStoredState";

export function SurvivalCalculator() {
  const [cash, setCash] = useStoredState("lifeleft.survival.cash", 20_000_000);
  const [fixed, setFixed] = useStoredState("lifeleft.survival.fixed", 1_500_000);
  const [variable, setVariable] = useStoredState("lifeleft.survival.variable", 800_000);
  const [income, setIncome] = useStoredState("lifeleft.survival.income", 0);

  const invalidInput = cash < 0 || fixed < 0 || variable < 0 || income < 0;

  const result = useMemo(() => {
    const safeCash = Math.max(0, cash);
    const expense = Math.max(0, fixed) + Math.max(0, variable);
    const burn = Math.max(0, expense - Math.max(0, income));
    const months = burn > 0 ? safeCash / burn : Number.POSITIVE_INFINITY;
    return { safeCash, expense, burn, months };
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
            <input type="number" inputMode="numeric" min="0" value={cash} onChange={(event) => setCash(Number(event.target.value))} />
          </label>
          <label>
            <span>월 고정지출</span>
            <input type="number" inputMode="numeric" min="0" value={fixed} onChange={(event) => setFixed(Number(event.target.value))} />
          </label>
          <label>
            <span>월 변동지출</span>
            <input type="number" inputMode="numeric" min="0" value={variable} onChange={(event) => setVariable(Number(event.target.value))} />
          </label>
          <label>
            <span>월 정기수입</span>
            <input type="number" inputMode="numeric" min="0" value={income} onChange={(event) => setIncome(Number(event.target.value))} />
          </label>
        </div>
        <InputNotice active={invalidInput} />
      </section>

      <section className="resultPanel">
        <ResultHero
          value={displayMonths}
          label="소득 중단 시 생존기간"
          factBadge={badge.fact}
          impactBadge={badge.impact}
          tone={badge.tone}
        />
        <ResultShare title="생존 잔량" value={displayMonths} factBadge={badge.fact} impactBadge={badge.impact} />

        <div className="metricGrid">
          <article><span>월 총지출</span><strong>{result.expense.toLocaleString()}원</strong></article>
          <article><span>월 순소모</span><strong>{result.burn.toLocaleString()}원</strong></article>
          <article><span>가용 현금</span><strong>{result.safeCash.toLocaleString()}원</strong></article>
        </div>

        <CashRunwayChart cash={result.safeCash} monthlyBurn={result.burn} months={result.months} />

        <details className="evidence">
          <summary>계산 근거</summary>
          <p>가용 현금 ÷ 월 순소모</p>
          <p>월 순소모 · 총지출 - 정기수입</p>
          <p>투자수익·이자·물가 변동 미반영</p>
          <p>입력 저장 · 현재 브라우저 기기</p>
        </details>
      </section>
    </div>
  );
}
