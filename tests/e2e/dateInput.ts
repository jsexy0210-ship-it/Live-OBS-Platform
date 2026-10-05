import type { Locator, Page } from "@playwright/test";

// 공통 날짜 선택(DatePicker)용 시험 도우미. 날짜 칸은 「2026.10.05」로 보이지만 「2026-10-05」를 써 넣어도 읽는다(fill 그대로 쓸 수 있다).
// 날짜+시각(DateTimePicker)은 날짜 칸과 시각 칸이 따로 있다: 접근 이름은 「<이름> 날짜」「<이름> 시각」.
export async function fillDateTime(scope: Page | Locator, label: string, value: string) {
  const [date, time = ""] = value.split("T");
  await scope.getByLabel(`${label} 날짜`, { exact: true }).fill(date);
  await scope.getByLabel(`${label} 시각`, { exact: true }).fill(time);
}
