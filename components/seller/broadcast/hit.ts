// HIT 카드 등급 추천 값(서버 HIT_GRADES와 같은 값, SA-053 필터·SA-001-M4 기록 창의 입력 칸 추천 목록). 등급은 자유 입력(12자 이내, 비우면 없음)이라 목록 밖 값도 받는다(형식 오류만 400 invalid_grade·invalid_filter).
export const HIT_GRADES = ["SAR", "SR", "UR", "SE", "SP", "AA"] as const;

// 방송 기록 「레이아웃」 열·필터 이름(서버 값 "9x16" 세로형 · "16x9" 가로형, 기록이 없으면 「—」)
export const LAYOUT_LABEL: Record<string, string> = { "9x16": "세로형", "16x9": "가로형" };
