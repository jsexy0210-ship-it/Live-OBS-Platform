"use client";

import { FitText } from "@/components/FitText";
import { useMemo } from "react";
import { SalaryCumulativeChart } from "@/components/Charts";
import { NumberField, SelectField } from "@/components/fields";
import { formatWon, range } from "@/lib/format";
import { InputNotice } from "@/components/InputNotice";
import { ResultHero } from "@/components/ResultHero";
import { ResultShare } from "@/components/ResultShare";
import { RetirementScenarios } from "@/components/RetirementScenarios";
import { SourceNote } from "@/components/SourceNote";
import { SOURCES, wageGroupFor } from "@/lib/stats";
import { salaryBadge } from "@/lib/badges";
import { useStoredState } from "@/lib/useStoredState";

export function SalaryCalculator() {
  const [currentAge, setCurrentAge] = useStoredState("lifeleft.salary.currentAge", 36);
  const [careerStartAge, setCareerStartAge] = useStoredState("lifeleft.salary.careerStartAge", 25);
  const [retirementAge, setRetirementAge] = useStoredState("lifeleft.salary.retirementAge", 60);
  const [monthlySalary, setMonthlySalary] = useStoredState("lifeleft.salary.monthlySalary", 4_000_000);

  const invalidInput =
    currentAge < 15 ||
    currentAge > 100 ||
    careerStartAge < 15 ||
    careerStartAge > currentAge ||
    retirementAge < currentAge ||
    retirementAge > 100 ||
    monthlySalary < 0;

  const result = useMemo(() => {
    const start = Math.max(15, Math.min(100, careerStartAge));
    const current = Math.max(start, Math.min(100, currentAge));
    const retirement = Math.max(current, Math.min(100, retirementAge));
    const totalMonths = Math.max(1, Math.round((retirement - start) * 12));
    const elapsedMonths = Math.min(totalMonths, Math.max(0, Math.round((current - start) * 12)));
    const remainingPays = Math.max(0, totalMonths - elapsedMonths);
    const remainingPercent = (remainingPays / totalMonths) * 100;
    const safeSalary = Math.max(0, monthlySalary);

    return {
      current,
      retirement,
      safeSalary,
      remainingPays,
      remainingPercent,
      futureTotal: remainingPays * safeSalary,
      annual: safeSalary * 12
    };
  }, [careerStartAge, currentAge, monthlySalary, retirementAge]);

  const badge = salaryBadge(result.remainingPercent);
  const wage = wageGroupFor(result.current);
  const mineManwon = result.safeSalary / 10_000;
  const peerMax = Math.max(mineManwon, wage.manwon, 1);
  const peerMine = Math.min(100, (mineManwon / peerMax) * 100);
  const peerRef = Math.min(100, (wage.manwon / peerMax) * 100);
  const peerDiff = Math.round(((mineManwon - wage.manwon) / wage.manwon) * 100);
  const resultValue = `${result.remainingPays.toLocaleString()}회`;

  return (
    <div className="calculatorLayout">
      <section className="inputPanel">
        <p className="eyebrow">현재 급여 유지 가정</p>
        <h1>월급 잔량</h1>
        <div className="formGrid">
          <SelectField label="현재 나이" value={currentAge} options={range(15, 100)} unit="세" onChange={setCurrentAge} />
          <SelectField label="직장 시작 나이" value={careerStartAge} options={range(15, 70)} unit="세" onChange={setCareerStartAge} />
          <SelectField label="예상 은퇴 나이" value={retirementAge} options={range(40, 90)} unit="세" onChange={setRetirementAge} />
          <NumberField label="현재 월 급여" value={monthlySalary} onChange={setMonthlySalary} unit="원" money />
        </div>
        <InputNotice active={invalidInput} />
      </section>

      <section className="resultPanel">
        <ResultHero
          value={resultValue}
          label="남은 월급"
          factBadge={badge.fact}
          impactBadge={badge.impact}
          tone={badge.tone}
        />
        <ResultShare title="월급 잔량" value={resultValue} factBadge={badge.fact} impactBadge={badge.impact} tone={badge.tone} />
        <div className="metricGrid">
          <article><span>미래 급여 총액</span><strong><FitText>{formatWon(result.futureTotal)}</FitText></strong></article>
          <article><span>연간 급여</span><strong><FitText>{formatWon(result.annual)}</FitText></strong></article>
          <article><span>급여 잔량</span><strong><FitText>{result.remainingPercent.toFixed(1)}%</FitText></strong></article>
        </div>
        <SalaryCumulativeChart currentAge={result.current} retirementAge={result.retirement} monthlySalary={result.safeSalary} />
        <section className="peerSection" aria-labelledby="peer-title">
          <div className="scenarioHead">
            <h3 id="peer-title">같은 연령대 공식 평균</h3>
            <span>{wage.label} · 월평균 세전 보수</span>
          </div>
          <div className="peerBars">
            <div>
              <span>입력 월급</span>
              <strong>{Math.round(result.safeSalary / 10_000).toLocaleString()}만원</strong>
              <span className="peerTrack"><span style={{ width: `${peerMine}%` }} /></span>
            </div>
            <div>
              <span>{wage.label} 평균</span>
              <strong>{wage.manwon.toLocaleString()}만원</strong>
              <span className="peerTrack peerTrackRef"><span style={{ width: `${peerRef}%` }} /></span>
            </div>
          </div>
          <p className="peerResult">
            {peerDiff === 0 ? "연령대 평균과 동일" : `연령대 평균 대비 ${peerDiff > 0 ? "+" : ""}${peerDiff}%`}
          </p>
          <SourceNote sources={[SOURCES.wages]} />
        </section>
        <RetirementScenarios
          currentAge={result.current}
          careerStartAge={careerStartAge}
          retirementAge={retirementAge}
          perYear={12}
          unit="회"
          onSelect={setRetirementAge}
        />
        <details className="evidence">
          <summary>계산 근거</summary>
          <p>남은 급여 횟수 · 예상 은퇴 나이까지 월 1회 기준</p>
          <p>미래 급여 총액 · 현재 월 급여 × 남은 급여 횟수</p>
          <p>연봉 상승·성과급·퇴직금·세금 변동 미반영</p>
          <p>입력 저장 · 현재 브라우저 기기</p>
        </details>
      </section>
    </div>
  );
}
