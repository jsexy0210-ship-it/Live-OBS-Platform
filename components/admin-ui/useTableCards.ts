"use client";

import { useEffect } from "react";

// 공통 표 모바일 카드(DS-TABLE-CARD, 768px 미만): 표 구조는 그대로 두고 칸에 역할(data-card)·라벨(data-label)만 붙인다. 카드 모양은 styles/lop.css의 @media 규칙이 만든다.
// 대상: .au-lt-wrap 안의 .tbl, 또는 .tbl.tbl-card(옵트인). 제외: .tbl-keep. 셸에서 한 번만 부른다.
// 역할 자동 판정: check(체크박스만) · thumb(그림만) · title(첫 글 칸, 링크 우선) · status(상태 배지 칸) · actions(마지막 칸, 버튼만) · wide(.col-text 또는 긴 글) · field(나머지).
// 라벨은 표 머리글을 그대로 쓰되 48px에 말줄임. 2~4자로 줄이려면 칸에 data-label-set과 data-label을 함께 쓴다.
// 화면이 정확히 정하려면 칸에 data-card="check|thumb|title|status|actions|wide|field|hide"를 직접 쓴다(자동 판정보다 우선). 값이 없으면 data-empty로 「-」를 보인다.
const TABLE = ".au-lt-wrap .tbl, .tbl.tbl-card";
const BTN = "button, a.btn, .btn";
const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();

function role(td: HTMLElement, i: number, last: number, head: string): string {
  const set = td.dataset.card;
  if (set) return set;
  const t = text(td);
  if (td.querySelector('input[type="checkbox"]') && !t) return "check";
  if (td.querySelector("img, .thumb") && !t) return "thumb";
  if (i === last && td.querySelector(BTN) && (!t || /^(관리|처리|작업|더보기)$/.test(head) || [...td.children].every((c) => c.matches(BTN) || c.querySelector(BTN)))) return "actions";
  if (td.querySelector(".bdg, .tag") && (/상태/.test(head) || !t.replace(text(td.querySelector(".bdg, .tag")!), "").trim())) return "status";
  if (td.classList.contains("col-text") || t.length > 24) return "wide";
  return "field";
}

function annotate(table: HTMLTableElement) {
  if (table.matches(".tbl-keep") || !table.tBodies.length) return;
  const heads = [...(table.tHead?.rows[0]?.cells ?? [])].map(text);
  table.dataset.cardTable = "1";
  for (const tr of table.tBodies[0].rows) {
    const cells = [...tr.cells];
    const roles = cells.map((td, i) => role(td, i, cells.length - 1, heads[i] ?? ""));
    // 제목: 직접 지정이 없으면 글 칸(field·wide) 중 링크가 있는 첫 칸, 없으면 첫 글 칸
    if (!cells.some((td) => td.dataset.card === "title")) {
      const text_ = (k: number) => roles[k] === "field" || roles[k] === "wide";
      const k = cells.findIndex((td, j) => text_(j) && !td.dataset.card && td.querySelector("a")) ;
      const first = k >= 0 ? k : roles.findIndex((_, j) => text_(j) && !cells[j].dataset.card);
      if (first >= 0) roles[first] = "title";
    }
    let lead = 0;
    cells.forEach((td, i) => {
      const r = roles[i];
      td.dataset.cardRole = r;
      if (r === "check") lead |= 1;
      if (r === "thumb") lead |= 2;
      if (heads[i] && !td.dataset.labelSet) td.dataset.label = heads[i];
      if (r === "field" || r === "wide") {
        if (text(td)) td.removeAttribute("data-empty");
        else td.dataset.empty = "1";
      }
    });
    tr.dataset.cardLead = String(lead);
    const act = cells.find((c) => c.dataset.cardRole === "actions");
    if (act && !act.querySelector(".card-more")) {
      const items = [...act.querySelectorAll<HTMLElement>(BTN)];
      items.forEach((b, k) => (k >= 2 ? b.setAttribute("data-extra", "") : b.removeAttribute("data-extra")));
      if (items.length > 2) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "btn btn-out card-more";
        more.setAttribute("aria-label", "더보기");
        more.setAttribute("aria-expanded", "false");
        more.textContent = "···";
        act.appendChild(more);
      }
    }
  }
}

export function useTableCards() {
  useEffect(() => {
    let raf = 0;
    const run = () => {
      raf = 0;
      document.querySelectorAll<HTMLTableElement>(TABLE).forEach(annotate);
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(run);
    };
    const mo = new MutationObserver(schedule);
    mo.observe(document.body, { childList: true, subtree: true });
    const onClick = (e: MouseEvent) => {
      const more = (e.target as Element | null)?.closest?.(".card-more") as HTMLElement | null;
      document.querySelectorAll<HTMLElement>('[data-card-role="actions"][data-open]').forEach((a) => {
        if (a !== more?.parentElement) {
          a.removeAttribute("data-open");
          a.querySelector(".card-more")?.setAttribute("aria-expanded", "false");
        }
      });
      if (!more) return;
      const cell = more.parentElement!;
      const open = !cell.hasAttribute("data-open");
      if (open) cell.setAttribute("data-open", "");
      else cell.removeAttribute("data-open");
      more.setAttribute("aria-expanded", String(open));
    };
    document.addEventListener("click", onClick);
    schedule();
    return () => {
      mo.disconnect();
      document.removeEventListener("click", onClick);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
}
