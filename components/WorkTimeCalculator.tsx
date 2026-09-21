"use client";

import { useMemo, useState } from "react";
import { WorkTimeMixChart, WorkYearBars } from "@/components/Charts";
import { ResultHero } from "@/components/ResultHero";
import { workTimeBadge } from "@/lib/badges";

const YEAR_MS = 365.2425 * 24 * 60 * 60 * 1000;

export function WorkTimeCalculator() {
  const [careerStartYear, setCareerStartYear] = useState(2015);
  const [dailyWorkHours, setDailyWorkHours] = useState(8);
  const [dailyCommuteHours, setDailyCommuteHours] = useState(2);
  const [weeklyDays, setWeeklyDays] = useState(5);
  const [annualLeave, setAnnualLeave] = useState(15);

  const result = useMemo(() => {
    const now = new Date();
    const start = new Date(Math.max(1970, careerStartYear), 0, 1);
    const yearsElapsed = Math.max(0, (now.getTime() - start.getTime()) / YEAR_MS);
    const annualWorkdays = Math.max(0, 52 * Math.max(0, weeklyDays) - Math.max(0, annualLeave));
    const annualWorkHours = annualWorkdays * Math.max(0, dailyWorkHours);
    const annualCommuteHours = annualWorkdays * Math.max(0, dailyCommuteHours);
    const workHours = yearsElapsed * annualWorkHours;
    const commuteHours = yearsElapsed * annualCommuteHours;
    const totalHours = workHours + commuteHours;
    const totalYears = totalHours / 24 / 365.2425;

    return {
      yearsElapsed,
      annualWorkHours,
      annualCommuteHours,
      workHours,
      commuteHours,
      totalHours,
      totalYears
    };
  }, [annualLeave, careerStartYear, dailyCommuteHours, dailyWorkHours, weeklyDays]);

  const badge = workTimeBadge(result.totalHours);

  return (
    <div className="calculatorLayout">
      <section className="inputPanel">
        <p className="eyebrow">사용자 입력 기반 추정</p>
        <h1>회사 누적시간</h1>
        <div className="formGrid">
          <label><span>직장 시작 연도</span><input type="number" min="1970" max="2100" value={careerStartYear} onChange={(event) => setCareerStartYear(Number(event.target.value))} /></label>
          <label><span>일 평균 근무시간</span><input type="number" min="0" max="24" step="0.5" value={dailyWorkHours} onChange={(event) => setDailyWorkHours(Number(event.target.value))} /></label>
          <label><span>일 왕복 출퇴근시간</span><input type="number" min="0" max="24" step="0.5" value={dailyCommuteHours} onChange={(event) => setDailyCommuteHours(Number(event.target.value))} /></label>
          <label><span>주간 근무일</span><input type="number" min="0" max="7" value={weeklyDays} onChange={(event) => setWeeklyDays(Number(event.target.value))} /></label>
          <label><span>연간 휴가일</span><input type="number" min="0" max="365" value={annualLeave} onChange={(event) => setAnnualLeave(Number(event.target.value))} /></label>
        </div>
      </section>

      <section className="resultPanel">
        <ResultHero
          value={`${Math.round(result.totalHours).toLocaleString()}시간`}
          label="회사 관련 누적시간"
          factBadge={badge.fact}
          impactBadge={badge.impact}
          tone={badge.tone}
        />
        <div className="metricGrid">
          <article><span>근무 누적</span><strong>{Math.round(result.workHours).toLocaleString()}시간</strong></article>
          <article><span>출퇴근 누적</span><strong>{Math.round(result.commuteHours).toLocaleString()}시간</strong></article>
          <article><span>24시간 환산</span><strong>{result.totalYears.toFixed(1)}년</strong></article>
        </div>
        <div className="chartGrid">
          <WorkTimeMixChart workHours={result.workHours} commuteHours={result.commuteHours} />
          <WorkYearBars yearsElapsed={result.yearsElapsed} annualWorkHours={result.annualWorkHours} annualCommuteHours={result.annualCommuteHours} />
        </div>
        <details className="evidence">
          <summary>계산 근거</summary>
          <p>연간 근무일 · 52주 × 주간 근무일 - 연간 휴가일</p>
          <p>누적시간 · 경력 기간 × 연간 근무·출퇴근시간</p>
          <p>공휴일·휴직·재택·실제 야근 변동 미반영</p>
        </details>
      </section>
    </div>
  );
}
