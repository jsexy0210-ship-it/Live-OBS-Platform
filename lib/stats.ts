// 공식 통계 Snapshot. 계산 순간 외부 API 호출 없음 (MVP_SPEC 8. 데이터 원칙).
// KOSIS 이용안내: 출처 표시 조건 상업적 활용 허용, 무가공 유료 판매 금지.

export type StatSource = {
  sourceName: string;
  publisher: string;
  sourceUrl: string;
  referenceDate: string;
  releasedAt: string;
  license: string;
};

const LICENSE = "KOSIS 이용안내 · 출처 표시 조건 상업적 이용 허용";

export const SOURCES = {
  lifeTable: {
    sourceName: "2024년 생명표",
    publisher: "국가데이터처",
    sourceUrl: "https://www.korea.kr/briefing/policyBriefingView.do?newsId=156732935",
    referenceDate: "2024",
    releasedAt: "2025-12-03",
    license: LICENSE
  },
  timeUse: {
    sourceName: "2024년 생활시간조사 결과",
    publisher: "국가데이터처",
    sourceUrl: "https://www.korea.kr/briefing/policyBriefingView.do?newsId=156721673",
    referenceDate: "2024",
    releasedAt: "2025-07-28",
    license: LICENSE
  },
  olderWorkers: {
    sourceName: "2025년 5월 경제활동인구조사 고령층 부가조사",
    publisher: "국가데이터처",
    sourceUrl: "https://www.korea.kr/briefing/pressReleaseView.do?newsId=156721125",
    referenceDate: "2025.05",
    releasedAt: "2025-08-06",
    license: LICENSE
  },
  wages: {
    sourceName: "2024년 임금근로일자리 소득(보수) 결과",
    publisher: "국가데이터처",
    sourceUrl: "https://www.korea.kr/briefing/pressReleaseView.do?newsId=156745446",
    referenceDate: "2024.12",
    releasedAt: "2026-02-23",
    license: LICENSE
  }
} satisfies Record<string, StatSource>;

// 2024년 생명표 · 전체 기대여명(년)
const LIFE_EXPECTANCY_POINTS: [number, number][] = [
  [0, 83.69],
  [20, 64.08],
  [30, 54.32],
  [40, 44.65],
  [50, 35.2],
  [60, 26.1],
  [70, 17.46]
];

/** 나이별 기대여명(년). 표 사이 구간 선형 보간, 70세 초과는 70세 값에서 연 0.6년 감소 근사 후 최소 3년. */
export function lifeExpectancyAt(age: number): number {
  const a = Math.max(0, age);
  for (let index = 1; index < LIFE_EXPECTANCY_POINTS.length; index += 1) {
    const [x1, y1] = LIFE_EXPECTANCY_POINTS[index];
    const [x0, y0] = LIFE_EXPECTANCY_POINTS[index - 1];
    if (a <= x1) return y0 + ((y1 - y0) * (a - x0)) / (x1 - x0);
  }
  const [lastAge, lastValue] = LIFE_EXPECTANCY_POINTS[LIFE_EXPECTANCY_POINTS.length - 1];
  return Math.max(3, lastValue - (a - lastAge) * 0.6);
}

export const LIFE_EXPECTANCY_AT_BIRTH = 83.7;

// 2024년 생활시간조사 · 10세 이상 · 요일 평균 · 행동분류 중분류(분/일)
export type TimeUseActivity = { key: string; label: string; minutes: number; group: "필수" | "의무" | "여가" };

export const TIME_USE: TimeUseActivity[] = [
  { key: "sleep", label: "수면", minutes: 8 * 60 + 4, group: "필수" },
  { key: "work", label: "일(구직 포함)", minutes: 3 * 60 + 7, group: "의무" },
  { key: "media", label: "미디어 이용", minutes: 2 * 60 + 43, group: "여가" },
  { key: "meal", label: "식사 및 간식", minutes: 60 + 54, group: "필수" },
  { key: "housework", label: "가사노동", minutes: 60 + 52, group: "의무" },
  { key: "care", label: "기타 개인유지", minutes: 60 + 34, group: "필수" },
  { key: "move", label: "이동", minutes: 60 + 32, group: "의무" },
  { key: "social", label: "교제 및 참여", minutes: 60, group: "여가" },
  { key: "study", label: "학습", minutes: 49, group: "의무" },
  { key: "otherLeisure", label: "기타 여가", minutes: 47, group: "여가" },
  { key: "sports", label: "스포츠 및 레포츠", minutes: 35, group: "여가" },
  { key: "culture", label: "문화 및 관광", minutes: 3, group: "여가" }
];

// 2025년 5월 고령층 부가조사 (55~79세)
export const OLDER_WORKERS = {
  longestJobExitAge: 52.9,
  desiredWorkUntilAge: 73.4
} as const;

export const LEGAL_RETIREMENT_AGE = 60;

// 2024년 12월 임금근로일자리 · 월평균 세전 보수(만원)
export const WAGE_BY_AGE: { min: number; max: number; label: string; manwon: number }[] = [
  { min: 0, max: 19, label: "19세 이하", manwon: 95 },
  { min: 20, max: 29, label: "20대", manwon: 271 },
  { min: 30, max: 39, label: "30대", manwon: 397 },
  { min: 40, max: 49, label: "40대", manwon: 469 },
  { min: 50, max: 59, label: "50대", manwon: 445 },
  { min: 60, max: 69, label: "60대", manwon: 293 },
  { min: 70, max: 200, label: "70세 이상", manwon: 165 }
];

export const WAGE_OVERALL_MANWON = 375;

export function wageGroupFor(age: number) {
  return WAGE_BY_AGE.find((group) => age >= group.min && age <= group.max) ?? WAGE_BY_AGE[WAGE_BY_AGE.length - 1];
}
