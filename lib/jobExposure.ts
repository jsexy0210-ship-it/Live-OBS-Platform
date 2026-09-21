// 직무 생성형 AI 노출도 Snapshot
// 출처: ILO Working Paper 140 「Generative AI and Jobs: A Refined Global Index of Occupational Exposure」(2025.05)
// 점수: 저자 공개 데이터(ISCO-08 4자리 직업의 과업별 점수) · 직업 점수 = 과업 점수 평균(0~1)
// 등급: ILO 분류 · 4 노출 최고 / 3 높음 / 2 중간 / 1 낮음 / 0 노출 미미 / -1 노출 없음

import type { BadgeTone } from "@/lib/badges";
import type { StatSource } from "@/lib/stats";

export const EXPOSURE_SOURCES: StatSource[] = [
  {
    sourceName: "Generative AI and Jobs: A Refined Global Index of Occupational Exposure (WP 140)",
    publisher: "ILO",
    sourceUrl: "https://www.ilo.org/sites/default/files/2025-05/WP140_web.pdf",
    referenceDate: "ISCO-08",
    releasedAt: "2025-05",
    license: "ILO 공표 자료 · 출처 표시"
  },
  {
    sourceName: "ISCO-08 직업별 과업 점수(저자 공개 데이터)",
    publisher: "ILO 연구진",
    sourceUrl: "https://pgmyrek.github.io/2025_GenAI_scores_ISCO08/",
    referenceDate: "ISCO-08",
    releasedAt: "2025",
    license: "공개 데이터 · 출처 표시"
  }
];

export type Gradient = 4 | 3 | 2 | 1 | 0 | -1;
export type Job = { code: string; label: string; group: string; isco: string; score: number; gradient: Gradient };

export const JOBS: Job[] = [
  { code: "4110", label: "일반 사무원", group: "사무·경영", isco: "General office clerks", score: 0.595, gradient: 4 },
  { code: "4120", label: "비서", group: "사무·경영", isco: "Secretaries (general)", score: 0.577, gradient: 3 },
  { code: "3343", label: "행정·경영 비서", group: "사무·경영", isco: "Administrative and executive secretaries", score: 0.536, gradient: 3 },
  { code: "4311", label: "회계·경리 사무원", group: "사무·경영", isco: "Accounting and bookkeeping clerks", score: 0.64, gradient: 4 },
  { code: "4313", label: "급여 담당 사무원", group: "사무·경영", isco: "Payroll clerks", score: 0.606, gradient: 4 },
  { code: "4416", label: "인사 사무원", group: "사무·경영", isco: "Personnel clerks", score: 0.605, gradient: 4 },
  { code: "4132", label: "데이터 입력원", group: "사무·경영", isco: "Data entry clerks", score: 0.7, gradient: 4 },
  { code: "4321", label: "재고 관리원", group: "사무·경영", isco: "Stock clerks", score: 0.369, gradient: 0 },
  { code: "4323", label: "운송·물류 사무원", group: "사무·경영", isco: "Transport clerks", score: 0.495, gradient: 3 },
  { code: "2421", label: "경영 컨설턴트", group: "사무·경영", isco: "Management and organization analysts", score: 0.46, gradient: 2 },
  { code: "1212", label: "인사 관리자", group: "사무·경영", isco: "Human resource managers", score: 0.356, gradient: 0 },
  { code: "1120", label: "경영자·CEO", group: "사무·경영", isco: "Managing directors and chief executives", score: 0.376, gradient: 0 },
  { code: "2512", label: "소프트웨어 개발자", group: "IT", isco: "Software developers", score: 0.527, gradient: 3 },
  { code: "2513", label: "웹·멀티미디어 개발자", group: "IT", isco: "Web and multimedia developers", score: 0.605, gradient: 4 },
  { code: "2514", label: "앱 프로그래머", group: "IT", isco: "Applications programmers", score: 0.571, gradient: 3 },
  { code: "2511", label: "시스템 분석가", group: "IT", isco: "Systems analysts", score: 0.49, gradient: 2 },
  { code: "2521", label: "DB 설계·관리자", group: "IT", isco: "Database designers and administrators", score: 0.568, gradient: 3 },
  { code: "2522", label: "시스템 관리자", group: "IT", isco: "Systems administrators", score: 0.566, gradient: 3 },
  { code: "2523", label: "네트워크 전문가", group: "IT", isco: "Computer network professionals", score: 0.516, gradient: 3 },
  { code: "3512", label: "IT 헬프데스크", group: "IT", isco: "Information and communications technology user support technicians", score: 0.47, gradient: 2 },
  { code: "1330", label: "IT 서비스 관리자", group: "IT", isco: "Information and communications technology service managers", score: 0.44, gradient: 2 },
  { code: "2411", label: "회계사", group: "금융", isco: "Accountants", score: 0.513, gradient: 3 },
  { code: "2412", label: "재무·투자 상담사", group: "금융", isco: "Financial and investment advisers", score: 0.575, gradient: 3 },
  { code: "2413", label: "금융 애널리스트", group: "금융", isco: "Financial analysts", score: 0.618, gradient: 4 },
  { code: "3311", label: "증권·금융 딜러", group: "금융", isco: "Securities and finance dealers and brokers", score: 0.631, gradient: 4 },
  { code: "3312", label: "대출 심사원", group: "금융", isco: "Credit and loans officers", score: 0.605, gradient: 4 },
  { code: "4211", label: "은행 창구 직원", group: "금융", isco: "Bank tellers and related clerks", score: 0.582, gradient: 3 },
  { code: "4312", label: "보험·금융 사무원", group: "금융", isco: "Statistical, finance and insurance clerks", score: 0.639, gradient: 4 },
  { code: "1211", label: "재무 관리자", group: "금융", isco: "Finance managers", score: 0.373, gradient: 0 },
  { code: "1221", label: "영업·마케팅 관리자", group: "영업·마케팅", isco: "Sales and marketing managers", score: 0.412, gradient: 2 },
  { code: "2431", label: "광고·마케팅 전문가", group: "영업·마케팅", isco: "Advertising and marketing professionals", score: 0.555, gradient: 3 },
  { code: "2432", label: "홍보(PR) 전문가", group: "영업·마케팅", isco: "Public relations professionals", score: 0.432, gradient: 2 },
  { code: "2434", label: "IT 영업 전문가", group: "영업·마케팅", isco: "Information and communications technology sales professionals", score: 0.512, gradient: 3 },
  { code: "3322", label: "기업 영업 담당", group: "영업·마케팅", isco: "Commercial sales representatives", score: 0.49, gradient: 2 },
  { code: "5244", label: "텔레마케터", group: "영업·마케팅", isco: "Contact centre salespersons", score: 0.612, gradient: 4 },
  { code: "4222", label: "콜센터 상담원", group: "영업·마케팅", isco: "Contact centre information clerks", score: 0.581, gradient: 3 },
  { code: "5223", label: "매장 판매원", group: "영업·마케팅", isco: "Shop sales assistants", score: 0.384, gradient: 1 },
  { code: "5230", label: "계산원", group: "영업·마케팅", isco: "Cashiers and ticket clerks", score: 0.394, gradient: 1 },
  { code: "3334", label: "부동산 중개인", group: "영업·마케팅", isco: "Real estate agents and property managers", score: 0.352, gradient: 0 },
  { code: "2641", label: "작가", group: "미디어·디자인", isco: "Authors and related writers", score: 0.545, gradient: 3 },
  { code: "2642", label: "기자", group: "미디어·디자인", isco: "Journalists", score: 0.536, gradient: 3 },
  { code: "2643", label: "번역가·통역사", group: "미디어·디자인", isco: "Translators, interpreters and other linguists", score: 0.593, gradient: 3 },
  { code: "2166", label: "그래픽·멀티미디어 디자이너", group: "미디어·디자인", isco: "Graphic and multimedia designers", score: 0.493, gradient: 2 },
  { code: "2163", label: "제품·패션 디자이너", group: "미디어·디자인", isco: "Product and garment designers", score: 0.35, gradient: 0 },
  { code: "3432", label: "인테리어 디자이너", group: "미디어·디자인", isco: "Interior designers and decorators", score: 0.367, gradient: 0 },
  { code: "2161", label: "건축가", group: "미디어·디자인", isco: "Building architects", score: 0.371, gradient: 0 },
  { code: "2654", label: "영화·방송 PD", group: "미디어·디자인", isco: "Film, stage and related directors and producers", score: 0.365, gradient: 0 },
  { code: "2651", label: "시각 예술가", group: "미디어·디자인", isco: "Visual artists", score: 0.21, gradient: -1 },
  { code: "2652", label: "음악가", group: "미디어·디자인", isco: "Musicians, singers and composers", score: 0.28, gradient: -1 },
  { code: "2211", label: "일반의", group: "의료·복지", isco: "Generalist medical practitioners", score: 0.287, gradient: -1 },
  { code: "2212", label: "전문의", group: "의료·복지", isco: "Specialist medical practitioners", score: 0.271, gradient: -1 },
  { code: "2261", label: "치과의사", group: "의료·복지", isco: "Dentists", score: 0.149, gradient: -1 },
  { code: "2262", label: "약사", group: "의료·복지", isco: "Pharmacists", score: 0.332, gradient: 0 },
  { code: "2221", label: "간호사", group: "의료·복지", isco: "Nursing professionals", score: 0.252, gradient: -1 },
  { code: "2264", label: "물리치료사", group: "의료·복지", isco: "Physiotherapists", score: 0.284, gradient: 0 },
  { code: "3212", label: "임상병리사", group: "의료·복지", isco: "Medical and pathology laboratory technicians", score: 0.307, gradient: 0 },
  { code: "5321", label: "간병·요양보호사", group: "의료·복지", isco: "Health care assistants", score: 0.141, gradient: -1 },
  { code: "2635", label: "사회복지사", group: "의료·복지", isco: "Social work and counselling professionals", score: 0.283, gradient: -1 },
  { code: "2310", label: "대학 교수", group: "교육", isco: "University and higher education teachers", score: 0.369, gradient: 0 },
  { code: "2330", label: "중·고등 교사", group: "교육", isco: "Secondary education teachers", score: 0.298, gradient: -1 },
  { code: "2341", label: "초등 교사", group: "교육", isco: "Primary school teachers", score: 0.261, gradient: -1 },
  { code: "2342", label: "유치원 교사", group: "교육", isco: "Early childhood educators", score: 0.208, gradient: -1 },
  { code: "5311", label: "보육 교사", group: "교육", isco: "Child care workers", score: 0.191, gradient: -1 },
  { code: "3422", label: "스포츠 강사", group: "교육", isco: "Sports coaches, instructors and officials", score: 0.374, gradient: 0 },
  { code: "2611", label: "변호사", group: "법·공공", isco: "Lawyers", score: 0.363, gradient: 0 },
  { code: "2612", label: "판사", group: "법·공공", isco: "Judges", score: 0.312, gradient: -1 },
  { code: "3411", label: "법률 사무원", group: "법·공공", isco: "Legal and related associate professionals", score: 0.391, gradient: 1 },
  { code: "5412", label: "경찰관", group: "법·공공", isco: "Police officers", score: 0.139, gradient: -1 },
  { code: "5411", label: "소방관", group: "법·공공", isco: "Fire-fighters", score: 0.183, gradient: -1 },
  { code: "2144", label: "기계 엔지니어", group: "기술·생산", isco: "Mechanical engineers", score: 0.323, gradient: -1 },
  { code: "2151", label: "전기 엔지니어", group: "기술·생산", isco: "Electrical engineers", score: 0.314, gradient: -1 },
  { code: "2152", label: "전자 엔지니어", group: "기술·생산", isco: "Electronics engineers", score: 0.424, gradient: 2 },
  { code: "2142", label: "토목 엔지니어", group: "기술·생산", isco: "Civil engineers", score: 0.302, gradient: -1 },
  { code: "7231", label: "자동차 정비원", group: "기술·생산", isco: "Motor vehicle mechanics and repairers", score: 0.178, gradient: -1 },
  { code: "7411", label: "전기 기술자", group: "기술·생산", isco: "Building and related electricians", score: 0.191, gradient: -1 },
  { code: "7212", label: "용접공", group: "기술·생산", isco: "Welders and flamecutters", score: 0.13, gradient: -1 },
  { code: "8211", label: "기계 조립원", group: "기술·생산", isco: "Mechanical machinery assemblers", score: 0.27, gradient: 0 },
  { code: "9329", label: "생산 단순 종사원", group: "기술·생산", isco: "Manufacturing labourers not elsewhere classified", score: 0.12, gradient: -1 },
  { code: "8322", label: "택시·승용차 운전원", group: "운송·서비스", isco: "Car, taxi and van drivers", score: 0.276, gradient: 1 },
  { code: "8331", label: "버스 기사", group: "운송·서비스", isco: "Bus and tram drivers", score: 0.179, gradient: -1 },
  { code: "8332", label: "화물차 운전원", group: "운송·서비스", isco: "Heavy truck and lorry drivers", score: 0.245, gradient: 0 },
  { code: "9621", label: "택배·배달원", group: "운송·서비스", isco: "Messengers, package deliverers and luggage porters", score: 0.37, gradient: 1 },
  { code: "9333", label: "물류 하역원", group: "운송·서비스", isco: "Freight handlers", score: 0.141, gradient: -1 },
  { code: "5120", label: "조리사", group: "운송·서비스", isco: "Cooks", score: 0.184, gradient: -1 },
  { code: "5131", label: "서빙 종업원", group: "운송·서비스", isco: "Waiters", score: 0.281, gradient: 0 },
  { code: "5141", label: "미용사", group: "운송·서비스", isco: "Hairdressers", score: 0.173, gradient: -1 },
  { code: "5414", label: "경비원", group: "운송·서비스", isco: "Security guards", score: 0.202, gradient: -1 },
  { code: "9112", label: "청소원", group: "운송·서비스", isco: "Cleaners and helpers in offices, hotels and other establishments", score: 0.119, gradient: -1 },
  { code: "7115", label: "목수", group: "운송·서비스", isco: "Carpenters and joiners", score: 0.13, gradient: -1 },
  { code: "9313", label: "건설 단순 종사원", group: "운송·서비스", isco: "Building construction labourers", score: 0.094, gradient: -1 },
];

export const JOB_GROUPS = Array.from(new Set(JOBS.map((job) => job.group)));

// ISCO-08 전체 427개 직업 점수(오름차순) · 백분위 계산용
const ALL_SCORES = [0.089,0.089,0.089,0.09,0.091,0.092,0.092,0.093,0.094,0.094,0.094,0.094,0.102,0.102,0.104,0.109,0.109,0.11,0.11,0.111,0.111,0.111,0.113,0.114,0.116,0.117,0.119,0.119,0.119,0.119,0.119,0.12,0.12,0.12,0.122,0.123,0.125,0.126,0.126,0.126,0.126,0.127,0.127,0.129,0.13,0.13,0.13,0.131,0.131,0.132,0.133,0.133,0.134,0.136,0.137,0.137,0.138,0.139,0.14,0.141,0.141,0.141,0.141,0.142,0.143,0.143,0.144,0.144,0.144,0.144,0.146,0.146,0.148,0.148,0.149,0.15,0.151,0.153,0.154,0.155,0.156,0.156,0.158,0.162,0.163,0.164,0.165,0.166,0.166,0.167,0.168,0.169,0.169,0.169,0.17,0.17,0.171,0.172,0.172,0.173,0.174,0.174,0.174,0.175,0.175,0.175,0.175,0.176,0.176,0.176,0.177,0.178,0.178,0.179,0.179,0.18,0.181,0.181,0.182,0.182,0.183,0.183,0.183,0.184,0.184,0.184,0.187,0.187,0.188,0.189,0.19,0.191,0.191,0.194,0.195,0.195,0.195,0.197,0.197,0.198,0.198,0.199,0.199,0.2,0.202,0.204,0.205,0.205,0.205,0.205,0.206,0.207,0.207,0.208,0.208,0.21,0.21,0.212,0.213,0.214,0.215,0.215,0.215,0.216,0.217,0.218,0.22,0.22,0.22,0.22,0.222,0.223,0.225,0.225,0.225,0.225,0.226,0.228,0.23,0.231,0.233,0.233,0.237,0.238,0.238,0.239,0.24,0.241,0.241,0.242,0.244,0.245,0.246,0.247,0.247,0.248,0.249,0.249,0.25,0.251,0.252,0.256,0.258,0.259,0.261,0.261,0.264,0.265,0.266,0.266,0.27,0.27,0.27,0.271,0.272,0.274,0.275,0.275,0.276,0.276,0.277,0.28,0.28,0.281,0.282,0.282,0.283,0.284,0.284,0.285,0.287,0.287,0.288,0.291,0.292,0.293,0.294,0.297,0.298,0.299,0.299,0.3,0.302,0.305,0.305,0.305,0.307,0.307,0.309,0.31,0.312,0.313,0.314,0.314,0.319,0.319,0.321,0.323,0.323,0.323,0.324,0.327,0.329,0.332,0.338,0.339,0.343,0.344,0.346,0.346,0.347,0.347,0.347,0.348,0.35,0.35,0.352,0.352,0.352,0.354,0.356,0.359,0.36,0.36,0.363,0.363,0.363,0.363,0.363,0.365,0.367,0.367,0.368,0.369,0.369,0.369,0.369,0.37,0.37,0.371,0.371,0.373,0.373,0.373,0.374,0.376,0.377,0.377,0.379,0.38,0.38,0.381,0.381,0.382,0.384,0.384,0.384,0.385,0.387,0.388,0.39,0.39,0.391,0.391,0.393,0.394,0.394,0.397,0.397,0.407,0.407,0.408,0.412,0.414,0.416,0.417,0.418,0.419,0.424,0.426,0.429,0.429,0.43,0.43,0.431,0.432,0.436,0.436,0.439,0.44,0.445,0.445,0.446,0.448,0.449,0.453,0.453,0.459,0.46,0.46,0.469,0.47,0.47,0.471,0.472,0.473,0.478,0.478,0.481,0.482,0.487,0.49,0.49,0.492,0.493,0.493,0.495,0.499,0.512,0.513,0.514,0.515,0.516,0.516,0.527,0.527,0.529,0.53,0.536,0.536,0.536,0.537,0.545,0.547,0.55,0.55,0.553,0.555,0.555,0.555,0.561,0.565,0.566,0.566,0.568,0.571,0.573,0.574,0.575,0.577,0.581,0.582,0.583,0.593,0.595,0.605,0.605,0.605,0.606,0.612,0.618,0.628,0.631,0.639,0.64,0.652,0.7];

/** 전체 직업 중 이 점수보다 노출도가 높은 직업 비율(%) · 작을수록 상위 */
export function exposureTopPercent(score: number) {
  const higher = ALL_SCORES.filter((value) => value > score).length;
  return Math.max(1, Math.round(((higher + 1) / ALL_SCORES.length) * 100));
}

export const ALL_OCCUPATION_COUNT = ALL_SCORES.length;

export const GRADIENT_META: Record<Gradient, { label: string; short: string; tone: BadgeTone }> = {
  4: { label: "AI 노출 최고 · 4등급", short: "최고", tone: "critical" },
  3: { label: "AI 노출 높음 · 3등급", short: "높음", tone: "danger" },
  2: { label: "AI 노출 중간 · 2등급", short: "중간", tone: "watch" },
  1: { label: "AI 노출 낮음 · 1등급", short: "낮음", tone: "neutral" },
  0: { label: "AI 노출 미미", short: "미미", tone: "neutral" },
  [-1]: { label: "AI 노출 없음", short: "없음", tone: "neutral" }
};

export function jobByCode(code: string) {
  return JOBS.find((job) => job.code === code) ?? JOBS[0];
}
