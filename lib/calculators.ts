export type CalculatorCategory = "횟수" | "시간" | "돈";

export type CalculatorEntry = {
  href: string;
  nav: string;
  title: string;
  category: CalculatorCategory;
  summary: string;
  unit: string;
};

export const CALCULATORS: CalculatorEntry[] = [
  { href: "/commute/", nav: "출근", title: "출근 잔량", category: "횟수", summary: "은퇴까지 남은 출근 횟수", unit: "회" },
  { href: "/salary/", nav: "월급", title: "월급 잔량", category: "횟수", summary: "은퇴까지 남은 월급 횟수", unit: "회" },
  { href: "/weekends/", nav: "주말", title: "주말 잔량", category: "횟수", summary: "기준 나이까지 남은 주말", unit: "회" },
  { href: "/work-time/", nav: "회사시간", title: "회사 누적시간", category: "시간", summary: "근무·출퇴근 누적 시간", unit: "시간" },
  { href: "/ranking/", nav: "시간랭킹", title: "인생 시간 랭킹", category: "시간", summary: "남은 인생 활동별 시간 순위", unit: "년" },
  { href: "/career/", nav: "커리어", title: "커리어 위치", category: "돈", summary: "산업 평균 대비 월급 위치·고용 흐름", unit: "%" },
  { href: "/subscriptions/", nav: "구독", title: "구독 누적", category: "돈", summary: "구독료 누적 결제액", unit: "원" },
  { href: "/survival/", nav: "생존", title: "생존 잔량", category: "돈", summary: "소득 중단 시 버틸 기간", unit: "개월" }
];

export const CATEGORY_ORDER: CalculatorCategory[] = ["횟수", "시간", "돈"];

export const CATEGORY_CODE: Record<CalculatorCategory, string> = {
  횟수: "COUNT",
  시간: "TIME",
  돈: "MONEY"
};
