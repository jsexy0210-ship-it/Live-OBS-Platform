"use client";

import { useMemo } from "react";
import { InputNotice } from "@/components/InputNotice";
import { ResultHero } from "@/components/ResultHero";
import { ResultShare } from "@/components/ResultShare";
import { subscriptionBadge } from "@/lib/badges";
import { useStoredState } from "@/lib/useStoredState";

type Row = {
  name: string;
  monthly: number;
  start: string;
};

function monthDiff(start: string) {
  const [year, month] = start.split("-").map(Number);
  if (!year || !month) return 0;
  const now = new Date();
  return Math.max(0, (now.getFullYear() - year) * 12 + (now.getMonth() + 1 - month) + 1);
}

export function SubscriptionCalculator() {
  const [rows, setRows] = useStoredState<Row[]>("lifeleft.subscriptions.rows", [
    { name: "Netflix", monthly: 17000, start: "2023-01" },
    { name: "ChatGPT", monthly: 32000, start: "2025-01" }
  ]);

  const invalidInput = rows.some((row) => !row.name.trim() || row.monthly < 0 || !row.start);

  const result = useMemo(() => {
    const monthly = rows.reduce((sum, row) => sum + Math.max(0, Number(row.monthly || 0)), 0);
    const total = rows.reduce(
      (sum, row) => sum + Math.max(0, Number(row.monthly || 0)) * monthDiff(row.start),
      0
    );
    const annual = monthly * 12;
    return { monthly, total, annual, tenYears: annual * 10 };
  }, [rows]);

  const badge = subscriptionBadge(result.annual);
  const resultValue = `${result.total.toLocaleString()}원`;

  const update = (index: number, patch: Partial<Row>) => {
    setRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row))
    );
  };

  return (
    <div className="calculatorLayout">
      <section className="inputPanel">
        <p className="eyebrow">사용자 입력 기반</p>
        <h1>구독 누적</h1>

        <div className="inputRows">
          {rows.map((row, index) => (
            <div className="inputRow" key={index}>
              <label>
                <span>서비스명</span>
                <input value={row.name} onChange={(event) => update(index, { name: event.target.value })} />
              </label>
              <label>
                <span>월 결제액</span>
                <input
                  type="number"
                  inputMode="numeric"
                  min="0"
                  value={row.monthly}
                  onChange={(event) => update(index, { monthly: Number(event.target.value) })}
                />
              </label>
              <label>
                <span>이용 시작</span>
                <input type="month" value={row.start} onChange={(event) => update(index, { start: event.target.value })} />
              </label>
            </div>
          ))}
        </div>

        <button
          className="secondaryButton"
          type="button"
          onClick={() => setRows((current) => [...current, { name: "기타", monthly: 0, start: "2026-01" }])}
        >
          구독 추가
        </button>
        <InputNotice active={invalidInput} />
      </section>

      <section className="resultPanel">
        <ResultHero
          value={resultValue}
          label="누적 구독료"
          factBadge={badge.fact}
          impactBadge={badge.impact}
          tone={badge.tone}
        />
        <ResultShare title="구독 누적" value={resultValue} factBadge={badge.fact} impactBadge={badge.impact} tone={badge.tone} />

        <div className="metricGrid">
          <article><span>월 고정비</span><strong>{result.monthly.toLocaleString()}원</strong></article>
          <article><span>1년 예상</span><strong>{result.annual.toLocaleString()}원</strong></article>
          <article><span>10년 예상</span><strong>{result.tenYears.toLocaleString()}원</strong></article>
        </div>

        <div className="depletionTrack" aria-label="10년 예상 구독료">
          <span style={{ width: `${Math.min(100, Math.max(4, result.annual / 30_000))}%` }} />
        </div>

        <details className="evidence">
          <summary>계산 근거</summary>
          <p>실제 월 결제액 × 이용 개월 수</p>
          <p>할인·결합·중도 해지 기간 미반영</p>
          <p>계산 유형 · 사용자 입력 기반</p>
          <p>입력 저장 · 현재 브라우저 기기</p>
        </details>
      </section>
    </div>
  );
}
