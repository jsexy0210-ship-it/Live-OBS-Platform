"use client";

import Link from "next/link";
import { useMemo } from "react";
import { commuteBadge, salaryBadge, weekendBadge, type BadgeTone } from "@/lib/badges";
import { useStoredState } from "@/lib/useStoredState";

const START_AGE = 25;
const RETIRE_AGE = 60;
const TARGET_AGE = 80;
const ANNUAL_WORKDAYS = 52 * 5 - 15;
const WEEKS_PER_YEAR = 365.2425 / 7;

type Tile = {
  href: string;
  label: string;
  value: number;
  unit: string;
  remainingPercent: number;
  impact: string;
  tone: BadgeTone;
};

export function QuickLife() {
  const [age, setAge] = useStoredState("lifeleft.quick.age", 36);
  const safeAge = Math.max(15, Math.min(100, Number.isFinite(age) ? age : 36));

  const tiles = useMemo<Tile[]>(() => {
    const worked = Math.max(START_AGE, safeAge);
    const careerYears = RETIRE_AGE - START_AGE;
    const workLeftYears = Math.max(0, RETIRE_AGE - worked);
    const workPercent = (workLeftYears / careerYears) * 100;

    const weekendLeftYears = Math.max(0, TARGET_AGE - safeAge);
    const weekendPercent = (weekendLeftYears / TARGET_AGE) * 100;

    const commute = commuteBadge(workPercent);
    const salary = salaryBadge(workPercent);
    const weekend = weekendBadge(weekendPercent);

    return [
      {
        href: "/weekends/",
        label: "남은 주말",
        value: Math.round(weekendLeftYears * WEEKS_PER_YEAR),
        unit: "회",
        remainingPercent: weekendPercent,
        impact: weekend.impact,
        tone: weekend.tone
      },
      {
        href: "/commute/",
        label: "남은 출근",
        value: Math.round(workLeftYears * ANNUAL_WORKDAYS),
        unit: "회",
        remainingPercent: workPercent,
        impact: commute.impact,
        tone: commute.tone
      },
      {
        href: "/salary/",
        label: "남은 월급",
        value: Math.round(workLeftYears * 12),
        unit: "회",
        remainingPercent: workPercent,
        impact: salary.impact,
        tone: salary.tone
      }
    ];
  }, [safeAge]);

  const invalid = age < 15 || age > 100;

  return (
    <div className="quickLife">
      <label className="ageInput">
        <span>현재 나이</span>
        <span className="ageField">
          <button type="button" aria-label="나이 1 감소" onClick={() => setAge(Math.max(15, safeAge - 1))}>−</button>
          <input
            type="number"
            inputMode="numeric"
            min="15"
            max="100"
            value={age}
            onChange={(event) => setAge(Number(event.target.value))}
          />
          <button type="button" aria-label="나이 1 증가" onClick={() => setAge(Math.min(100, safeAge + 1))}>+</button>
        </span>
        {invalid ? <small className="ageNotice">15~100세 범위 보정</small> : <small>세 · 입력 즉시 계산</small>}
      </label>

      <div className="quickGrid">
        {tiles.map((tile) => (
          <Link className="quickTile" href={tile.href} key={tile.label} data-tone={tile.tone}>
            <span className="quickLabel">{tile.label}</span>
            <strong className="quickValue">
              {tile.value.toLocaleString()}
              <small>{tile.unit}</small>
            </strong>
            <span className="meter" aria-hidden="true">
              <span style={{ width: `${Math.max(0, Math.min(100, tile.remainingPercent))}%` }} />
            </span>
            <span className="quickMeta">
              <span>잔량 {tile.remainingPercent.toFixed(0)}%</span>
              <span className="toneText">{tile.impact}</span>
            </span>
            <span className="quickCta">상세 계산 →</span>
          </Link>
        ))}
      </div>

      <p className="quickBasis">
        기본 가정 · 직장 시작 {START_AGE}세 · 은퇴 {RETIRE_AGE}세 · 주 5일 · 연차 15일 · 주말 기준 {TARGET_AGE}세
      </p>
    </div>
  );
}
