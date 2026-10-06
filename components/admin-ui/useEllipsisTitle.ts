"use client";

import { useEffect } from "react";

// 표 말줄임 칸(.tbl .ell)이 실제로 잘렸을 때 마우스를 올리면 전체 글을 title 툴팁으로 보여 준다(DESIGN_PROMPT 「표 겹침·정렬 전수 수정」).
// 셸에서 한 번만 부른다. 잘리지 않은 칸에는 title을 달지 않고, 한 번 단 title은 글이 바뀌면 다시 맞춘다.
export function useEllipsisTitle() {
  useEffect(() => {
    const onOver = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.(".tbl .ell") as HTMLElement | null;
      if (!el) return;
      const text = (el.textContent ?? "").trim();
      if (el.scrollWidth > el.clientWidth && text) el.title = text;
      else el.removeAttribute("title");
    };
    document.addEventListener("mouseover", onOver);
    return () => document.removeEventListener("mouseover", onOver);
  }, []);
}
