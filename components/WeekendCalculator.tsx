"use client";

import { useMemo } from "react";
import { DepletionDonut, LifeGrid } from "@/components/Charts";
import { InputNotice } from "@/components/InputNotice";
import { ResultHero } from "@/components/ResultHero";
import { ResultShare } from "@/components/ResultShare";
import { SourceNote } from "@/components/SourceNote";
import { lifeExpectancyAt, SOURCES } from "@/lib/stats";
import { weekendBadge } from "@/lib/badges";
import { useStoredState } from "@/lib/useStoredState";

const WEEKS_PER_YEAR = 365.2425 / 7;

export function WeekendCalculator() {
  const [currentAge, setCurrentAge] = useStoredState("lifeleft.weekends.currentAge", 36);
  const [targetAge, setTargetAge] = useStoredState("lifeleft.weekends.targetAge", 80);

  const invalidInput = currentAge < 0 || currentAge > 120 || targetAge <= currentAge || targetAge > 120;

  const result = useMemo(() => {
    const current = Math.max(0, Math.min(120, currentAge));
    const target = Math.max(current + 1, Math.min(120, targetAge));
    const remainingYears = Math.max(0, target - current);
    const remainingWeekends = Math.round(remainingYears * WEEKS_PER_YEAR);
    const usedPercent = target > 0 ? Math.min(100, (current / target) * 100) : 0;
    const remainingPercent = 100 - usedPercent;

    return {
      remainingWeekends,
      usedPercent,
      remainingPercent,
      summers: Math.floor(remainingYears),
      yearEnds: Math.floor(remainingYears),
      birthdays: Math.floor(remainingYears)
    };
  }, [currentAge, targetAge]);

  const badge = weekendBadge(result.remainingPercent);
  const resultValue = `${result.remainingWeekends.toLocaleString()}회`;

  return (
    <div className="calculatorLayout">
      <section className="inputPanel">
        <p className="eyebrow">선택 연령 기준 단순 계산</p>
        <h1>주말 잔량</h1>
        <div className="formGrid">
          <label><span>현재 나이</span><input type="number" min="0" max="120" value={currentAge} onChange={(event) => setCurrentAge(Number(event.target.value))} /></label>
          <label><span>계산 기준 나이</span><input type="number" min="1" max="120" value={targetAge} onChange={(event) => setTargetAge(Number(event.target.value))} /></label>
        </div>
        <div className="presetBox">
          <button
            type="button"
            className="secondaryButton"
            onClick={() => setTargetAge(Math.round(Math.max(0, Math.min(120, currentAge)) + lifeExpectancyAt(currentAge)))}
          >
            기대여명 기준 적용 · {Math.round(Math.max(0, Math.min(120, currentAge)) + lifeExpectancyAt(currentAge))}세
          </button>
          <p>{Math.round(currentAge)}세 기대여명 {lifeExpectancyAt(currentAge).toFixed(1)}년 · 전체 인구 평균 · 개인 수명 예측 아님</p>
          <SourceNote sources={[SOURCES.lifeTable]} />
        </div>
        <InputNotice active={invalidInput} />
      </section>

      <section className="resultPanel">
        <ResultHero
          value={resultValue}
          label="남은 주말"
          factBadge={badge.fact}
          impactBadge={badge.impact}
          tone={badge.tone}
        />
        <ResultShare title="주말 잔량" value={resultValue} factBadge={badge.fact} impactBadge={badge.impact} tone={badge.tone} />
        <div className="metricGrid">
          <article><span>남은 여름</span><strong>{result.summers.toLocaleString()}회</strong></article>
          <article><span>남은 연말</span><strong>{result.yearEnds.toLocaleString()}회</strong></article>
          <article><span>남은 생일</span><strong>{result.birthdays.toLocaleString()}회</strong></article>
        </div>
        <div className="chartGrid">
          <LifeGrid used={result.usedPercent} title="주말 Life Grid" />
          <DepletionDonut used={result.usedPercent} remaining={result.remainingPercent} />
        </div>
        <details className="evidence">
          <summary>계산 근거</summary>
          <p>연간 평균 주수 · 365.2425일 ÷ 7일</p>
          <p>사용자 선택 기준 나이까지 단순 계산</p>
          <p>개인 실제 수명 예측 아님</p>
          <p>입력 저장 · 현재 브라우저 기기</p>
        </details>
      </section>
    </div>
  );
}
