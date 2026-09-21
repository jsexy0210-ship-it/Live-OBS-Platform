"use client";

import { useMemo } from "react";
import { BirthField } from "@/components/BirthField";
import { InputNotice } from "@/components/InputNotice";
import { ResultHero } from "@/components/ResultHero";
import { ResultShare } from "@/components/ResultShare";
import { SourceNote } from "@/components/SourceNote";
import { lifeExpectancyAt, SOURCES, TIME_USE } from "@/lib/stats";
import { useBirthProfile } from "@/lib/profile";

const DAYS_PER_YEAR = 365.2425;
const GROUP_TONE = { 필수: "neutral", 의무: "danger", 여가: "watch" } as const;

export function TimeRanking() {
  const { age } = useBirthProfile();
  const invalid = age < 0 || age > 100;
  const safeAge = Math.max(0, Math.min(100, Number.isFinite(age) ? age : 36));

  const result = useMemo(() => {
    const remainingYears = lifeExpectancyAt(safeAge);
    const rows = TIME_USE.map((activity) => {
      const hours = (activity.minutes / 60) * DAYS_PER_YEAR * remainingYears;
      return { ...activity, hours, years: hours / 24 / DAYS_PER_YEAR };
    }).sort((a, b) => b.minutes - a.minutes);
    return { remainingYears, rows, max: rows[0]?.years ?? 1 };
  }, [safeAge]);

  const sleep = result.rows.find((row) => row.key === "sleep");
  const media = result.rows.find((row) => row.key === "media");
  const value = `${result.remainingYears.toFixed(1)}년`;
  const fact = `수면 ${sleep?.years.toFixed(1)}년`;
  const impact = `미디어 ${media?.years.toFixed(1)}년`;

  return (
    <div className="calculatorLayout">
      <section className="inputPanel">
        <p className="eyebrow">공식 통계 기반</p>
        <h1>인생 시간 랭킹</h1>
        <div className="formGrid">
          <BirthField />
        </div>
        <InputNotice active={invalid} />
        <p className="panelNote">
          남은 시간 · 2024년 생명표 기대여명
          <br />
          활동 배분 · 2024년 생활시간조사 10세 이상 요일 평균
        </p>
      </section>

      <section className="resultPanel">
        <ResultHero value={value} label="남은 시간 · 기대여명 기준" factBadge={fact} impactBadge={impact} tone="neutral" />
        <ResultShare title="인생 시간 랭킹" value={value} factBadge={fact} impactBadge={impact} tone="neutral" />

        <ol className="rankList">
          {result.rows.map((row, index) => (
            <li key={row.key} data-tone={GROUP_TONE[row.group]}>
              <span className="rankNo">{String(index + 1).padStart(2, "0")}</span>
              <span className="rankBody">
                <span className="rankTop">
                  <strong>{row.label}</strong>
                  <span className="rankValue">{row.years.toFixed(1)}년</span>
                </span>
                <span className="meter" aria-hidden="true">
                  <span style={{ width: `${Math.max(1, (row.years / result.max) * 100)}%` }} />
                </span>
                <span className="rankMeta">
                  <span>{row.group}</span>
                  <span>하루 {Math.floor(row.minutes / 60)}시간 {row.minutes % 60}분 · {Math.round(row.hours).toLocaleString()}시간</span>
                </span>
              </span>
            </li>
          ))}
        </ol>

        <details className="evidence">
          <summary>계산 근거</summary>
          <p>활동별 남은 시간 · 하루 평균 시간 × 365.2425일 × 기대여명</p>
          <p>기대여명 · 2024년 생명표 전체 인구 기준 연령별 값, 표 사이 선형 보간</p>
          <p>생활시간 · 10세 이상 전체 평균, 취업·연령·성별 차이 미반영</p>
          <p>개인 실제 수명·생활 패턴 예측 아님</p>
        </details>
        <SourceNote sources={[SOURCES.lifeTable, SOURCES.timeUse]} />
      </section>
    </div>
  );
}
