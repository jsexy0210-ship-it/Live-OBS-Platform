// HIT 카드 등급 고정 목록(서버 HIT_GRADES와 같은 값, SA-053 필터·SA-001-M4 기록 창 공용). 목록 밖 값은 서버가 거부한다(400 invalid_grade·invalid_filter).
export const HIT_GRADES = ["SAR", "SR", "UR", "SE", "SP", "AA"] as const;

// 방송 기록 「레이아웃」 열·필터 이름(서버 값 "9x16" 세로형 · "16x9" 가로형, 기록이 없으면 「—」)
export const LAYOUT_LABEL: Record<string, string> = { "9x16": "세로형", "16x9": "가로형" };
