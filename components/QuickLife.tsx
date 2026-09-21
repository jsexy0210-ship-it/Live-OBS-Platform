"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { FitText } from "@/components/FitText";
import { commuteBadge, salaryBadge, weekendBadge, type BadgeTone } from "@/lib/badges";
import { useStoredState } from "@/lib/useStoredState";

const START_AGE = 25;
const RETIRE_AGE = 60;
const TARGET_AGE = 80;
const ANNUAL_WORKDAYS = 52 * 5 - 15;
const WEEKS_PER_YEAR = 365.2425 / 7;
const AGE_OPTIONS = Array.from({ length: 86 }, (_, i) => i + 15);

type Tile = {
  key: "w" | "c" | "s";
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
        key: "w",
        href: "/weekends/",
        label: "남은 주말",
        value: Math.round(weekendLeftYears * WEEKS_PER_YEAR),
        unit: "회",
        remainingPercent: weekendPercent,
        impact: weekend.impact,
        tone: weekend.tone
      },
      {
        key: "c",
        href: "/commute/",
        label: "남은 출근",
        value: Math.round(workLeftYears * ANNUAL_WORKDAYS),
        unit: "회",
        remainingPercent: workPercent,
        impact: commute.impact,
        tone: commute.tone
      },
      {
        key: "s",
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
  const [friend, setFriend] = useState<Partial<Record<Tile["key"], number>> | null>(null);
  const [shareStatus, setShareStatus] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const parsed: Partial<Record<Tile["key"], number>> = {};
    for (const key of ["w", "c", "s"] as const) {
      const raw = params.get(key);
      if (raw === null) continue;
      const value = Number(raw);
      if (Number.isInteger(value) && value >= 0 && value <= 100_000) parsed[key] = value;
    }
    if (Object.keys(parsed).length > 0) setFriend(parsed);
  }, []);

  async function shareCompare() {
    const query = tiles.map((tile) => `${tile.key}=${tile.value}`).join("&");
    const url = `${window.location.origin}/?${query}`;
    const text = ["인생잔량 비교", ...tiles.map((tile) => `${tile.label} ${tile.value.toLocaleString()}${tile.unit}`)].join("\n");
    try {
      if (navigator.share) {
        await navigator.share({ title: "인생잔량 비교 | LifeLeft", text, url });
        setShareStatus("공유 완료");
        return;
      }
      await navigator.clipboard.writeText(`${text}\n${url}`);
      setShareStatus("비교 링크 복사 완료");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setShareStatus("공유 실패");
    }
  }

  return (
    <div className="quickLife">
      {friend ? (
        <p className="friendBanner" role="status">
          <strong>친구 결과 도착</strong>
          <span>내 나이 입력 · 즉시 비교</span>
        </p>
      ) : null}
      <div className="ageInput">
        <label htmlFor="quick-age">현재 나이</label>
        <span className="ageField">
          <button type="button" aria-label="나이 1 감소" onClick={() => setAge(Math.max(15, safeAge - 1))}>−</button>
          <select id="quick-age" value={safeAge} onChange={(event) => setAge(Number(event.target.value))}>
            {AGE_OPTIONS.map((option) => (
              <option key={option} value={option}>{option}세</option>
            ))}
          </select>
          <button type="button" aria-label="나이 1 증가" onClick={() => setAge(Math.min(100, safeAge + 1))}>+</button>
        </span>
        {invalid ? <small className="ageNotice">15~100세 범위 보정</small> : <small>선택 즉시 계산</small>}
      </div>

      <div className="quickGrid">
        {tiles.map((tile) => (
          <Link className="quickTile" href={tile.href} key={tile.key} data-tone={tile.tone}>
            <span className="quickLabel">{tile.label}</span>
            <strong className="quickValue">
              <FitText>
                {tile.value.toLocaleString()}
                <small>{tile.unit}</small>
              </FitText>
            </strong>
            <span className="meter" aria-hidden="true">
              <span style={{ width: `${Math.max(0, Math.min(100, tile.remainingPercent))}%` }} />
            </span>
            <span className="quickMeta">
              <span>잔량 {tile.remainingPercent.toFixed(0)}%</span>
              <span className="toneText">{tile.impact}</span>
            </span>
            {friend?.[tile.key] !== undefined ? (
              <span className="friendLine">
                <span>친구 {friend[tile.key]!.toLocaleString()}{tile.unit}</span>
                <span className="toneText">
                  {tile.value === friend[tile.key]
                    ? "동일"
                    : `나 ${tile.value > friend[tile.key]! ? "+" : ""}${(tile.value - friend[tile.key]!).toLocaleString()}${tile.unit}`}
                </span>
              </span>
            ) : null}
            <span className="quickCta">상세 계산 →</span>
          </Link>
        ))}
      </div>

      <div className="resultActions quickActions">
        <button className="primaryButton" type="button" onClick={shareCompare}>
          친구 비교 링크
        </button>
        <span className="actionStatus" aria-live="polite">{shareStatus}</span>
      </div>

      <p className="quickBasis">
        기본 가정 · 직장 시작 {START_AGE}세 · 은퇴 {RETIRE_AGE}세 · 주 5일 · 연차 15일 · 주말 기준 {TARGET_AGE}세
      </p>
    </div>
  );
}
