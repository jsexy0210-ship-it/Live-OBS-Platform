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

// ---------- 커리어 위치 (/career) ----------

export const CAREER_SOURCES = {
  minimumWage: {
    sourceName: "2026년 적용 최저임금 시간급 10,320원",
    publisher: "고용노동부",
    sourceUrl: "https://www.moel.go.kr/news/enews/report/enewsView.do?news_seq=18144",
    referenceDate: "2026",
    releasedAt: "2025-08-05",
    license: LICENSE
  },
  employmentAnnual: {
    sourceName: "2025년 12월 및 연간 고용동향",
    publisher: "국가데이터처",
    sourceUrl: "https://www.korea.kr/briefing/pressReleaseView.do?newsId=156739551",
    referenceDate: "2025",
    releasedAt: "2026-01-14",
    license: LICENSE
  },
  employmentMonthly: {
    sourceName: "2026년 8월 고용동향",
    publisher: "국가데이터처",
    sourceUrl: "https://www.korea.kr/briefing/pressReleaseView.do?newsId=156780760",
    referenceDate: "2026.08",
    releasedAt: "2026-09-09",
    license: LICENSE
  },
  cpiAnnual: {
    sourceName: "2025년 12월 및 연간 소비자물가동향",
    publisher: "국가데이터처",
    sourceUrl: "https://www.korea.kr/briefing/pressReleaseView.do?newsId=156737587",
    referenceDate: "2025",
    releasedAt: "2025-12-31",
    license: LICENSE
  },
  cpiMonthly: {
    sourceName: "2026년 8월 소비자물가동향",
    publisher: "국가데이터처",
    sourceUrl: "https://www.korea.kr/briefing/pressReleaseView.do?newsId=156777172",
    referenceDate: "2026.08",
    releasedAt: "2026-09-02",
    license: LICENSE
  },
  gdp: {
    sourceName: "2024년 국민계정(확정) 및 2025년 국민계정(잠정)",
    publisher: "한국은행",
    sourceUrl: "https://www.bok.or.kr/portal/bbs/B0000501/view.do?nttId=10098382&menuNo=201264&programType=newsData",
    referenceDate: "2025",
    releasedAt: "2026-06-09",
    license: "한국은행 공표 자료 · 출처 표시"
  }
} satisfies Record<string, StatSource>;

export const CAREER_SOURCE_LIST: StatSource[] = [
  SOURCES.wages,
  CAREER_SOURCES.employmentAnnual,
  CAREER_SOURCES.employmentMonthly,
  CAREER_SOURCES.minimumWage,
  CAREER_SOURCES.cpiAnnual,
  CAREER_SOURCES.cpiMonthly,
  CAREER_SOURCES.gdp
];

export const ECONOMY = {
  minimumHourly2026: 10_320,
  minimumHourly2025: 10_030,
  minimumMonthly2026: 2_156_880,
  minimumGrowth2026: 2.9,
  standardMonthlyHours: 209,
  cpi2025: 2.1,
  cpi202608: 3.1,
  gdp2025: 1.1
} as const;

export type EmploymentGroup = { label: string; annual: number; annualDiff: number; annualRate: number; month: number; monthDiff: number; monthRate: number };

// 경제활동인구조사 · 취업자(천명) · 2025 연간 전년비 / 2026.8 전년동월비
export const EMPLOYMENT: Record<string, EmploymentGroup> = {
  agri: { label: "농림어업", annual: 1378, annualDiff: -107, annualRate: -7.2, month: 1358, monthDiff: -109, monthRate: -7.4 },
  manufacturing: { label: "제조업", annual: 4382, annualDiff: -73, annualRate: -1.6, month: 4325, monthDiff: -38, monthRate: -0.9 },
  construction: { label: "건설업", annual: 1940, annualDiff: -125, annualRate: -6.1, month: 1878, monthDiff: -32, monthRate: -1.7 },
  retail: { label: "도매 및 소매업", annual: 3213, annualDiff: -1, annualRate: 0, month: 3226, monthDiff: 21, monthRate: 0.7 },
  transport: { label: "운수 및 창고업", annual: 1717, annualDiff: 16, annualRate: 0.9, month: 1758, monthDiff: 21, monthRate: 1.2 },
  hospitality: { label: "숙박 및 음식점업", annual: 2319, annualDiff: -3, annualRate: -0.1, month: 2259, monthDiff: -61, monthRate: -2.6 },
  ict: { label: "정보통신업", annual: 1139, annualDiff: 30, annualRate: 2.7, month: 1147, monthDiff: 28, monthRate: 2.5 },
  finance: { label: "금융 및 보험업", annual: 811, annualDiff: 44, annualRate: 5.7, month: 833, monthDiff: 23, monthRate: 2.9 },
  realEstate: { label: "부동산업", annual: 528, annualDiff: 8, annualRate: 1.6, month: 545, monthDiff: 9, monthRate: 1.7 },
  professional: { label: "전문·과학 및 기술서비스업", annual: 1476, annualDiff: 54, annualRate: 3.8, month: 1472, monthDiff: -5, monthRate: -0.3 },
  businessSupport: { label: "사업시설관리, 사업지원 및 임대서비스업", annual: 1374, annualDiff: -6, annualRate: -0.4, month: 1448, monthDiff: 45, monthRate: 3.2 },
  publicAdmin: { label: "공공행정·국방 및 사회보장 행정", annual: 1329, annualDiff: 21, annualRate: 1.6, month: 1361, monthDiff: 32, monthRate: 2.4 },
  education: { label: "교육 서비스업", annual: 1944, annualDiff: 43, annualRate: 2.3, month: 1934, monthDiff: -24, monthRate: -1.2 },
  health: { label: "보건업 및 사회복지서비스업", annual: 3177, annualDiff: 237, annualRate: 8.0, month: 3476, monthDiff: 186, monthRate: 5.6 },
  arts: { label: "예술·스포츠 및 여가관련서비스업", annual: 553, annualDiff: 31, annualRate: 5.9, month: 626, monthDiff: 73, monthRate: 13.3 },
  associations: { label: "협회 및 단체·수리 및 기타개인서비스업", annual: 1145, annualDiff: 15, annualRate: 1.3, month: 1134, monthDiff: -13, monthRate: -1.1 },
  other: { label: "기타(광업·전기가스·수도·국제기관 등)", annual: 344, annualDiff: 9, annualRate: 2.7, month: 373, monthDiff: 28, monthRate: 8.0 }
};

export type Industry = { key: string; label: string; official: string; wage2024: number; wage2023: number; employment: keyof typeof EMPLOYMENT };

// 2024년 임금근로일자리 소득 · 산업대분류별 월평균 세전 보수(만원)
export const INDUSTRIES: Industry[] = [
  { key: "finance", label: "금융·보험", official: "금융 및 보험업", wage2024: 777, wage2023: 753, employment: "finance" },
  { key: "utilities", label: "전기·가스·증기", official: "전기, 가스, 증기 및 공기조절 공급업", wage2024: 699, wage2023: 675, employment: "other" },
  { key: "intl", label: "국제·외국기관", official: "국제 및 외국기관", wage2024: 538, wage2023: 510, employment: "other" },
  { key: "mining", label: "광업", official: "광업", wage2024: 524, wage2023: 500, employment: "other" },
  { key: "ict", label: "정보통신", official: "정보통신업", wage2024: 517, wage2023: 502, employment: "ict" },
  { key: "manufacturing", label: "제조", official: "제조업", wage2024: 488, wage2023: 469, employment: "manufacturing" },
  { key: "professional", label: "전문·과학·기술", official: "전문, 과학 및 기술 서비스업", wage2024: 447, wage2023: 436, employment: "professional" },
  { key: "publicAdmin", label: "공공행정·국방", official: "공공행정, 국방 및 사회보장 행정", wage2024: 430, wage2023: 415, employment: "publicAdmin" },
  { key: "education", label: "교육 서비스", official: "교육 서비스업", wage2024: 418, wage2023: 407, employment: "education" },
  { key: "water", label: "수도·하수·폐기물", official: "수도, 하수 및 폐기물 처리, 원료재생업", wage2024: 411, wage2023: 398, employment: "other" },
  { key: "transport", label: "운수·창고", official: "운수 및 창고업", wage2024: 355, wage2023: 352, employment: "transport" },
  { key: "retail", label: "도매·소매", official: "도매 및 소매업", wage2024: 328, wage2023: 313, employment: "retail" },
  { key: "construction", label: "건설", official: "건설업", wage2024: 324, wage2023: 317, employment: "construction" },
  { key: "realEstate", label: "부동산", official: "부동산업", wage2024: 299, wage2023: 290, employment: "realEstate" },
  { key: "arts", label: "예술·스포츠·여가", official: "예술, 스포츠 및 여가관련 서비스업", wage2024: 295, wage2023: 287, employment: "arts" },
  { key: "health", label: "보건·사회복지", official: "보건업 및 사회복지서비스업", wage2024: 276, wage2023: 267, employment: "health" },
  { key: "businessSupport", label: "사업시설관리·지원·임대", official: "사업시설 관리, 사업지원 및 임대 서비스업", wage2024: 252, wage2023: 243, employment: "businessSupport" },
  { key: "agri", label: "농업·임업·어업", official: "농업, 임업 및 어업", wage2024: 244, wage2023: 243, employment: "agri" },
  { key: "associations", label: "협회·단체·수리·기타개인", official: "협회 및 단체, 수리 및 기타 개인 서비스업", wage2024: 229, wage2023: 223, employment: "associations" },
  { key: "hospitality", label: "숙박·음식점", official: "숙박 및 음식점업", wage2024: 188, wage2023: 181, employment: "hospitality" }
];
