"use client";

import { FitText } from "@/components/FitText";
import { useMemo } from "react";
import { WorkTimeMixChart, WorkYearBars } from "@/components/Charts";
import { SelectField } from "@/components/fields";
import { range } from "@/lib/format";
import { InputNotice } from "@/components/InputNotice";
import { ResultHero } from "@/components/ResultHero";
import { ResultShare } from "@/components/ResultShare";
import { workTimeBadge } from "@/lib/badges";
import { useStoredState } from "@/lib/useStoredState";

const YEAR_MS = 365.2425 * 24 * 60 * 60 * 1000;

export function WorkTimeCalculator() {
  const currentYear = new Date().getFullYear();
  const [careerStartYear, setCareerStartYear] = useStoredState("lifeleft.workTime.careerStartYear", 2015);
  const [dailyWorkHours, setDailyWorkHours] = useStoredState("lifeleft.workTime.dailyWorkHours", 8);
  const [dailyCommuteHours, setDailyCommuteHours] = useStoredState("lifeleft.workTime.dailyCommuteHours", 2);
  const [weeklyDays, setWeeklyDays] = useStoredState("lifeleft.workTime.weeklyDays", 5);
  const [annualLeave, setAnnualLeave] = useStoredState("lifeleft.workTime.annualLeave", 15);

  const invalidInput =
    careerStartYear < 1970 ||
    careerStartYear > currentYear ||
    dailyWorkHours < 0 ||
    dailyWorkHours > 24 ||
    dailyCommuteHours < 0 ||
    dailyCommuteHours > 24 ||
    weeklyDays < 0 ||
    weeklyDays > 7 ||
    annualLeave < 0 ||
    annualLeave > 365;

  const result = useMemo(() => {
    const now = new Date();
    const safeStartYear = Math.max(1970, Math.min(now.getFullYear(), careerStartYear));
    const start = new Date(safeStartYear, 0, 1);
    const yearsElapsed = Math.max(0, (now.getTime() - start.getTime()) / YEAR_MS);
    const safeWorkHours = Math.max(0, Math.min(24, dailyWorkHours));
    const safeCommuteHours = Math.max(0, Math.min(24, dailyCommuteHours));
    const safeWeeklyDays = Math.max(0, Math.min(7, weeklyDays));
    const safeAnnualLeave = Math.max(0, Math.min(365, annualLeave));
    const annualWorkdays = Math.max(0, 52 * safeWeeklyDays - safeAnnualLeave);
    const annualWorkHours = annualWorkdays * safeWorkHours;
    const annualCommuteHours = annualWorkdays * safeCommuteHours;
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
  const resultValue = `${Math.round(result.totalHours).toLocaleString()}시간`;

  return (
    <div className="calculatorLayout">
      <section className="inputPanel">
        <p className="eyebrow">사용자 입력 기반 추정</p>
        <h1>회사 누적시간</h1>
        <div className="formGrid">
          <SelectField label="직장 시작 연도" value={careerStartYear} options={range(currentYear, 1970)} format={(year) => `${year}년`} onChange={setCareerStartYear} />
          <SelectField label="일 평균 근무시간" value={dailyWorkHours} options={range(1, 16, 0.5)} unit="시간" onChange={setDailyWorkHours} />
          <SelectField label="일 왕복 출퇴근시간" value={dailyCommuteHours} options={range(0, 6, 0.5)} unit="시간" onChange={setDailyCommuteHours} />
          <SelectField label="주간 근무일" value={weeklyDays} options={range(1, 7)} unit="일" onChange={setWeeklyDays} />
          <SelectField label="연간 휴가일" value={annualLeave} options={range(0, 40)} unit="일" onChange={setAnnualLeave} />
        </div>
        <InputNotice active={invalidInput} />
      </section>

      <section className="resultPanel">
        <ResultHero
          value={resultValue}
          label="회사 관련 누적시간"
          factBadge={badge.fact}
          impactBadge={badge.impact}
          tone={badge.tone}
        />
        <ResultShare title="회사 누적시간" value={resultValue} factBadge={badge.fact} impactBadge={badge.impact} tone={badge.tone} />
        <div className="metricGrid">
          <article><span>근무 누적</span><strong><FitText>{Math.round(result.workHours).toLocaleString()}시간</FitText></strong></article>
          <article><span>출퇴근 누적</span><strong><FitText>{Math.round(result.commuteHours).toLocaleString()}시간</FitText></strong></article>
          <article><span>24시간 환산</span><strong><FitText>{result.totalYears.toFixed(1)}년</FitText></strong></article>
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
          <p>입력 저장 · 현재 브라우저 기기</p>
        </details>
      </section>
    </div>
  );
}
