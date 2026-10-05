"use client";

import { useEffect } from "react";

// 날짜·시각 입력은 칸 어디를 눌러도 달력이 열린다(대표님 지시 2026-10-05 「Date Picker 전체 Input 클릭」).
// 화면마다 onClick을 붙이지 않고 관리자 셸(파트너스·마스터)에서 한 번만 건다. 직접 입력·Tab·키보드·min/max·required·onChange는 브라우저 기본 그대로다.
// showPicker를 지원하지 않는 브라우저, 비활성·읽기 전용 칸은 건드리지 않는다. 이미 열려 있거나 사용자 동작이 아니라서 거절되면(예외) 기본 동작에 맡긴다.
const PICKER_TYPES = new Set(["date", "datetime-local", "month", "week", "time"]);

export function useWholeDateClick() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const t = e.target;
      if (!(t instanceof HTMLInputElement) || !PICKER_TYPES.has(t.type) || t.disabled || t.readOnly) return;
      if (typeof t.showPicker !== "function") return;
      try {
        t.showPicker();
      } catch {
        // 기본 동작에 맡긴다
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
}
