"use client";

import { SourceNote } from "@/components/SourceNote";
import { LEGAL_RETIREMENT_AGE, OLDER_WORKERS, SOURCES } from "@/lib/stats";

type Props = {
  currentAge: number;
  careerStartAge: number;
  retirementAge: number;
  perYear: number;
  unit: string;
  onSelect: (age: number) => void;
};

const SCENARIOS = [
  { age: Math.round(OLDER_WORKERS.longestJobExitAge), tag: "평균 퇴직", note: `주된 일자리 평균 ${OLDER_WORKERS.longestJobExitAge}세` },
  { age: LEGAL_RETIREMENT_AGE, tag: "법정 정년", note: "고령자고용법 기준" },
  { age: 65, tag: "연금 개시", note: "국민연금 수급 개시 · 1969년생 이후" },
  { age: Math.round(OLDER_WORKERS.desiredWorkUntilAge), tag: "희망 근로", note: `고령층 희망 평균 ${OLDER_WORKERS.desiredWorkUntilAge}세` }
];

function remainingFor(age: number, currentAge: number, careerStartAge: number, perYear: number) {
  const from = Math.max(currentAge, careerStartAge);
  return Math.max(0, Math.round((age - from) * perYear));
}

export function RetirementScenarios({ currentAge, careerStartAge, retirementAge, perYear, unit, onSelect }: Props) {
  const base = remainingFor(retirementAge, currentAge, careerStartAge, perYear);

  return (
    <section className="scenarioSection" aria-labelledby="scenario-title">
      <div className="scenarioHead">
        <h3 id="scenario-title">은퇴 시점 시뮬레이션</h3>
        <span>선택 시 입력값 반영</span>
      </div>
      <div className="scenarioGrid">
        {SCENARIOS.map((scenario) => {
          const value = remainingFor(scenario.age, currentAge, careerStartAge, perYear);
          const diff = value - base;
          const active = scenario.age === retirementAge;
          return (
            <button
              type="button"
              className="scenarioCard"
              aria-pressed={active}
              key={scenario.tag}
              onClick={() => onSelect(scenario.age)}
            >
              <span className="scenarioTag">{scenario.tag} · {scenario.age}세</span>
              <strong>
                {value.toLocaleString()}
                <small>{unit}</small>
              </strong>
              <span className={diff > 0 ? "scenarioDiff up" : diff < 0 ? "scenarioDiff down" : "scenarioDiff"}>
                {active ? "현재 선택" : diff === 0 ? "변화 없음" : `${diff > 0 ? "+" : ""}${diff.toLocaleString()}${unit}`}
              </span>
              <small className="scenarioNote">{scenario.note}</small>
            </button>
          );
        })}
      </div>
      <SourceNote sources={[SOURCES.olderWorkers]} />
    </section>
  );
}
