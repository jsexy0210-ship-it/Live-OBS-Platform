"use client";

import Link from "next/link";
import { useId } from "react";
import { FitText } from "@/components/FitText";
import { ResultShare } from "@/components/ResultShare";
import { SourceNote } from "@/components/SourceNote";
import {
  ALL_OCCUPATION_COUNT,
  EXPOSURE_SOURCES,
  GRADIENT_META,
  JOB_GROUPS,
  JOBS,
  exposureTopPercent,
  jobByCode,
  type Job
} from "@/lib/jobExposure";
import { useStoredState } from "@/lib/useStoredState";

const toIndex = (score: number) => Math.round(score * 100);
const BY_SCORE = [...JOBS].sort((a, b) => b.score - a.score);
const TOP = BY_SCORE.slice(0, 5);
const BOTTOM = BY_SCORE.slice(-5).reverse();

function Board({ title, jobs, onPick, current }: { title: string; jobs: Job[]; onPick: (code: string) => void; current: string }) {
  return (
    <div className="exposureBoard">
      <h3>{title}</h3>
      <ol>
        {jobs.map((job, index) => (
          <li key={job.code} data-tone={GRADIENT_META[job.gradient].tone}>
            <button type="button" onClick={() => onPick(job.code)} aria-pressed={job.code === current}>
              <span className="rankNo">{index + 1}</span>
              <span className="boardLabel">{job.label}</span>
              <span className="toneText">{toIndex(job.score)}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 직무 생성형 AI 노출도 · ILO 2025 지수 */
export function JobExposure({ variant }: { variant: "home" | "career" }) {
  const selectId = useId();
  const [code, setCode] = useStoredState("lifeleft.career.job", "2512");
  const job = jobByCode(code);
  const meta = GRADIENT_META[job.gradient];
  const index = toIndex(job.score);
  const top = exposureTopPercent(job.score);
  const value = `${index}점`;
  const fact = top <= 50 ? `노출 상위 ${top}%` : `노출 하위 ${Math.max(1, 101 - top)}%`;

  const picker = (
    <div className="field">
      <label htmlFor={selectId}>직업</label>
      <span className="selectWrap">
        <select id={selectId} value={job.code} onChange={(event) => setCode(event.target.value)}>
          {JOB_GROUPS.map((group) => (
            <optgroup key={group} label={group}>
              {JOBS.filter((item) => item.group === group).map((item) => (
                <option key={item.code} value={item.code}>
                  {item.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </span>
    </div>
  );

  const scoreCard = (
    <div className="exposureCard" data-tone={meta.tone}>
      <span className="eyebrow">생성형 AI 노출 지수 · 100점 만점</span>
      <strong className="exposureValue">
        <FitText>
          {index}
          <small>점</small>
        </FitText>
      </strong>
      <span className="meter" aria-hidden="true">
        <span style={{ width: `${index}%` }} />
      </span>
      <div className="badgeRow">
        <span className="badge badgeFact">{fact}</span>
        <span className={`badge badge-${meta.tone}`}>{meta.label}</span>
      </div>
      <p className="exposureNote">
        {job.label} · ISCO-08 {job.code} {job.isco} · {ALL_OCCUPATION_COUNT}개 직업 기준
      </p>
    </div>
  );

  if (variant === "career") {
    return (
      <section className="peerSection" aria-labelledby="exposure-title">
        <div className="scenarioHead">
          <h3 id="exposure-title">직무 AI 노출도</h3>
          <span>대체 확정 아님 · 업무 중 AI 수행 가능 비중</span>
        </div>
        {picker}
        {scoreCard}
        <SourceNote sources={EXPOSURE_SOURCES} />
      </section>
    );
  }

  return (
    <section className="exposureSection" aria-labelledby="exposure-home-title">
      <div className="sectionHeading">
        <p className="sectionKicker">AI EXPOSURE · ILO 2025</p>
        <h2 id="exposure-home-title">직무 AI 노출도</h2>
      </div>
      <div className="exposureLayout">
        <div className="exposureMain">
          {picker}
          {scoreCard}
          <ResultShare title={`${job.label} AI 노출도`} value={value} factBadge={fact} impactBadge={meta.label} tone={meta.tone} />
          <Link className="exposureLink" href="/career/">
            커리어 위치 · 산업 평균 월급·고용 흐름 확인 →
          </Link>
        </div>
        <div className="exposureBoards">
          <Board title="노출 높은 직업 TOP 5" jobs={TOP} onPick={setCode} current={job.code} />
          <Board title="노출 낮은 직업 TOP 5" jobs={BOTTOM} onPick={setCode} current={job.code} />
        </div>
      </div>
      <p className="exposureNote">
        노출도 · 직업을 구성하는 과업 중 생성형 AI가 수행 가능한 정도의 평균. 일자리 소멸·대체 시점 예측 아님.
      </p>
      <SourceNote sources={EXPOSURE_SOURCES} />
    </section>
  );
}
