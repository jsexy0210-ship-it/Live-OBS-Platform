"use client";

import { useMemo } from "react";
import { CommuteTimelineChart, DepletionDonut } from "@/components/Charts";
import { InputNotice } from "@/components/InputNotice";
import { ResultHero } from "@/components/ResultHero";
import { ResultShare } from "@/components/ResultShare";
import { RetirementScenarios } from "@/components/RetirementScenarios";
import { commuteBadge } from "@/lib/badges";
import { useStoredState } from "@/lib/useStoredState";

export function CommuteCalculator() {
  const [currentAge, setCurrentAge] = useStoredState("lifeleft.commute.currentAge", 36);
  const [careerStartAge, setCareerStartAge] = useStoredState("lifeleft.commute.careerStartAge", 25);
  const [retirementAge, setRetirementAge] = useStoredState("lifeleft.commute.retirementAge", 60);
  const [weeklyDays, setWeeklyDays] = useStoredState("lifeleft.commute.weeklyDays", 5);
  const [annualLeave, setAnnualLeave] = useStoredState("lifeleft.commute.annualLeave", 15);

  const invalidInput =
    currentAge < 15 ||
    currentAge > 100 ||
    careerStartAge < 15 ||
    careerStartAge > currentAge ||
    retirementAge < currentAge ||
    retirementAge > 100 ||
    weeklyDays < 0 ||
    weeklyDays > 7 ||
    annualLeave < 0 ||
    annualLeave > 365;

  const result = useMemo(() => {
    const start = Math.max(15, Math.min(100, careerStartAge));
    const current = Math.max(start, Math.min(100, currentAge));
    const retirement = Math.max(current, Math.min(100, retirementAge));
    const safeWeeklyDays = Math.max(0, Math.min(7, weeklyDays));
    const safeAnnualLeave = Math.max(0, Math.min(365, annualLeave));
    const totalCareerYears = Math.max(1, retirement - start);
    const elapsedYears = Math.max(0, current - start);
    const annualWorkdays = Math.max(0, 52 * safeWeeklyDays - safeAnnualLeave);
    const totalCommutes = Math.round(totalCareerYears * annualWorkdays);
    const usedCommutes = Math.min(totalCommutes, Math.round(elapsedYears * annualWorkdays));
    const remainingCommutes = Math.max(0, totalCommutes - usedCommutes);
    const remainingPercent = totalCommutes > 0 ? (remainingCommutes / totalCommutes) * 100 : 0;

    return {
      current,
      retirement,
      usedCommutes,
      remainingCommutes,
      remainingPercent,
      remainingHours: remainingCommutes * 8
    };
  }, [annualLeave, careerStartAge, currentAge, retirementAge, weeklyDays]);

  const badge = commuteBadge(result.remainingPercent);
  const resultValue = `${result.remainingCommutes.toLocaleString()}회`;

  return (
    <div className="calculatorLayout">
      <section className="inputPanel">
        <p className="eyebrow">사용자 입력 기반 추정</p>
        <h1>출근 잔량</h1>
        <div className="formGrid">
          <label><span>현재 나이</span><input type="number" min="15" max="100" value={currentAge} onChange={(event) => setCurrentAge(Number(event.target.value))} /></label>
          <label><span>직장 시작 나이</span><input type="number" min="15" max="100" value={careerStartAge} onChange={(event) => setCareerStartAge(Number(event.target.value))} /></label>
          <label><span>예상 은퇴 나이</span><input type="number" min="15" max="100" value={retirementAge} onChange={(event) => setRetirementAge(Number(event.target.value))} /></label>
          <label><span>주간 출근일</span><input type="number" min="0" max="7" value={weeklyDays} onChange={(event) => setWeeklyDays(Number(event.target.value))} /></label>
          <label><span>연간 휴가일</span><input type="number" min="0" max="365" value={annualLeave} onChange={(event) => setAnnualLeave(Number(event.target.value))} /></label>
        </div>
        <InputNotice active={invalidInput} />
      </section>

      <section className="resultPanel">
        <ResultHero
          value={resultValue}
          label="남은 출근"
          factBadge={badge.fact}
          impactBadge={badge.impact}
          tone={badge.tone}
        />
        <ResultShare title="출근 잔량" value={resultValue} factBadge={badge.fact} impactBadge={badge.impact} tone={badge.tone} />
        <div className="metricGrid">
          <article><span>소모 출근</span><strong>{result.usedCommutes.toLocaleString()}회</strong></article>
          <article><span>잔량 비율</span><strong>{result.remainingPercent.toFixed(1)}%</strong></article>
          <article><span>남은 근무시간</span><strong>{result.remainingHours.toLocaleString()}시간</strong></article>
        </div>
        <div className="chartGrid">
          <DepletionDonut used={100 - result.remainingPercent} remaining={result.remainingPercent} />
          <CommuteTimelineChart currentAge={result.current} retirementAge={result.retirement} remainingCommutes={result.remainingCommutes} />
        </div>
        <RetirementScenarios
          currentAge={result.current}
          careerStartAge={careerStartAge}
          retirementAge={retirementAge}
          perYear={Math.max(0, 52 * Math.max(0, Math.min(7, weeklyDays)) - Math.max(0, Math.min(365, annualLeave)))}
          unit="회"
          onSelect={setRetirementAge}
        />
        <details className="evidence">
          <summary>계산 근거</summary>
          <p>연간 출근 추정 · 52주 × 주간 출근일 - 연간 휴가일</p>
          <p>공휴일·휴직·회사별 휴무일 미반영</p>
          <p>공휴일 Snapshot 연결 전 · 사용자 입력 기반 추정</p>
          <p>입력 저장 · 현재 브라우저 기기</p>
        </details>
      </section>
    </div>
  );
}
