"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { addDays, addMonths, activeQuick, daysBetween, formatDateInput, monthGrid, parseDateInput, parseTimeInput, quickRange, QUICK_RANGES, todayKst, type QuickKey } from "../../lib/client/dateInput";

// 공통 날짜 선택(DS-DATEPICKER 정본, 대표님 지시 2026-10-06 「네이버식」): 기본 input type=date를 대체한다. 화면마다 따로 만들지 않는다.
// - 칸: 값 「2026.10.05」, 빈 칸 「날짜 선택」, 오른쪽 달력 아이콘, 칸 어디를 눌러도 달력이 열린다(직접 입력·Tab·키보드도 됨: Tab으로 들어와서는 열리지 않고 ↓·Enter로 연다). 높이 40(관리자)·44(폼)·48(휴대폰)은 .inp 규격을 따른다
// - 값은 모두 「YYYY-MM-DD」 문자열(input type=date와 같음), 값이 없으면 「」
// - 달력: 「‹ 2026.10 ›」, 일요일 빨강·토요일 파랑, 오늘은 테두리 원, 고른 날은 채운 원, 기간은 사이 연한 배경, 이번 달 밖은 흐리게, min·max 밖은 흐린 취소선
// - 하루 선택은 날짜를 누르면 바로 닫히고, 기간은 두 번 눌러 [적용]. Esc·바깥 클릭은 값 유지하고 닫기. 화살표·PageUp/Down·Enter 키보드 이동. 휴대폰(767 이하)은 아래에서 올라오는 시트
// 사용:
//   <DatePicker aria-label="등록일 시작" value={from} onChange={(v) => setFrom(v)} max={to || undefined} />
//   <DateRangePicker fromLabel="시작일" toLabel="종료일" from={from} to={to} onChange={({ from, to }) => …} quick />
//   <DateTimePicker aria-label="시작 시각" value="2026-10-05T22:25" onChange={(v) => …} />   // 「YYYY-MM-DDTHH:mm」, 한국 시간
// 스타일: styles/lop.css (.dt-*)

type Tone = "admin" | "shop";
const TEXT = {
  admin: { placeholder: "날짜 선택", from: "시작일", to: "종료일", reset: "초기화", apply: "적용", pickOne: "날짜를 고르면 바로 닫힙니다", pickEnd: "종료일을 골라 주십시오 · 시작일보다 앞은 고를 수 없습니다", prev: "이전 달", next: "다음 달", cal: "날짜 선택" },
  shop: { placeholder: "날짜 선택", from: "시작일", to: "종료일", reset: "초기화", apply: "적용", pickOne: "받고 싶은 날을 골라 주세요", pickEnd: "끝나는 날을 골라 주세요", prev: "이전 달", next: "다음 달", cal: "날짜 선택" },
} as const;
// 입력 칸에서 아래 화살표: 열린 달력의 멈춤 날로 포커스를 옮긴다
const enterCalendar = (id: string) => document.getElementById(id)?.querySelector<HTMLButtonElement>('.dt-day[tabindex="0"]')?.focus();
const leavePicker = (anchor: HTMLElement | null, id: string, close: () => void) => {
  setTimeout(() => {
    const active = document.activeElement;
    if (!anchor?.contains(active) && !document.getElementById(id)?.contains(active)) close();
  }, 0);
};
const DOW = ["일", "월", "화", "수", "목", "금", "토"];

type FieldProps = { id?: string; className?: string; disabled?: boolean; readOnly?: boolean; tone?: Tone; placeholder?: string; "aria-label"?: string; "aria-invalid"?: boolean; min?: string; max?: string };

const CalIcon = () => (
  <svg className="dt-ic" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3.5" y="5" width="17" height="15" rx="2" />
    <path d="M8 3v4M16 3v4M3.5 10h17" />
  </svg>
);

const ym = (iso: string) => ({ y: Number(iso.slice(0, 4)), m: Number(iso.slice(5, 7)) });
const inRange = (iso: string, min?: string, max?: string) => (!min || iso >= min) && (!max || iso <= max);

// 달력 한 달(머리 이동 포함). selected: 고른 날(들), preview: 기간 사이 칠하기
function Calendar({ cursor, setCursor, from, to, hover, min, max, onPick, onHover, tone }: {
  cursor: string; setCursor: (iso: string) => void; from: string; to?: string; hover?: string; min?: string; max?: string;
  onPick: (iso: string) => void; onHover?: (iso: string) => void; tone: Tone;
}) {
  const t = TEXT[tone];
  const { y, m } = ym(cursor);
  const grid = useMemo(() => monthGrid(y, m), [y, m]);
  const today = todayKst();
  const lo = from && (to || hover) ? (from <= (to || hover || from) ? from : (to || hover || from)) : "";
  const hi = from && (to || hover) ? (from <= (to || hover || from) ? (to || hover || from) : from) : "";
  const root = useRef<HTMLDivElement>(null);
  // Tab이 달력에 들어올 때 멈출 날 하나: 고른 날 → 오늘 → 이번 달 첫날
  const [focused, setFocused] = useState("");
  const available = grid.flat().filter((c) => c.inMonth && inRange(c.iso, min, max));
  const stop = available.find((c) => c.iso === focused)?.iso ?? available.find((c) => c.iso === from)?.iso ?? available.find((c) => c.iso === today)?.iso ?? available[0]?.iso;
  const key = (e: React.KeyboardEvent, iso: string) => {
    const step: Record<string, string> = { ArrowLeft: addDays(iso, -1), ArrowRight: addDays(iso, 1), ArrowUp: addDays(iso, -7), ArrowDown: addDays(iso, 7), PageUp: addMonths(iso, -1), PageDown: addMonths(iso, 1) };
    const next = step[e.key];
    if (!next) return;
    e.preventDefault();
    if (!inRange(next, min, max)) return;
    setFocused(next);
    setCursor(next);
    requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>(`[data-iso="${next}"]`)?.focus());
  };
  return (
    <div className="dt-cal" ref={root}>
      <div className="dt-head">
        <button type="button" className="dt-nav" aria-label={t.prev} onClick={() => setCursor(addMonths(cursor, -1))}>
          ‹
        </button>
        <b aria-live="polite">{`${y}.${String(m).padStart(2, "0")}`}</b>
        <button type="button" className="dt-nav" aria-label={t.next} onClick={() => setCursor(addMonths(cursor, 1))}>
          ›
        </button>
      </div>
      <div className="dt-dow" aria-hidden="true">
        {DOW.map((d, i) => (
          <span key={d} className={i === 0 ? "sun" : i === 6 ? "sat" : undefined}>
            {d}
          </span>
        ))}
      </div>
      <div className="dt-grid" role="group" aria-label={`${y}년 ${m}월`}>
        {grid.flat().map((c, i) => {
          const ok = inRange(c.iso, min, max);
          const sel = c.iso === from || c.iso === to;
          const mid = lo && hi && c.iso > lo && c.iso < hi;
          const cls = ["dt-day", i % 7 === 0 ? "sun" : i % 7 === 6 ? "sat" : "", c.inMonth ? "" : "out", sel ? "sel" : "", mid ? "mid" : "", c.iso === today ? "today" : "", ok ? "" : "off"].filter(Boolean).join(" ");
          return (
            <button key={c.iso} type="button" data-iso={c.iso} className={cls} disabled={!ok} aria-pressed={sel} aria-current={c.iso === today ? "date" : undefined} aria-label={`${c.iso.replace(/-/g, ".")}`} tabIndex={c.iso === stop ? 0 : -1} onFocus={() => setFocused(c.iso)} onClick={() => onPick(c.iso)} onMouseEnter={() => onHover?.(c.iso)} onKeyDown={(e) => key(e, c.iso)}>
              {c.day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// 팝오버: 칸 아래에 붙고, 휴대폰은 아래 시트. 바깥 클릭·Esc는 닫기
function Popover({ anchor, onClose, children, label, id }: { anchor: React.RefObject<HTMLElement | null>; onClose: () => void; children: React.ReactNode; label: string; id: string }) {
  const box = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [theme, setTheme] = useState<React.CSSProperties>({});
  const [scope, setScope] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const el = anchor.current;
    if (!el) return;
    opener.current = el.contains(document.activeElement) ? document.activeElement as HTMLElement : el.querySelector("input");
    // 검색 패널의 overflow/transform에서 분리하되, 부모 모달의 포커스 범위는 유지한다.
    setHost(document.body);
    const themed = el.closest(".c24,.sh24");
    setScope(themed?.classList.contains("sh24") ? "sh24" : themed?.classList.contains("c24") ? "c24" : "");
    const computed = getComputedStyle(el);
    const variables: Record<string, string> = {};
    for (let i = 0; i < computed.length; i++) {
      const name = computed[i];
      if (name.startsWith("--")) variables[name] = computed.getPropertyValue(name);
    }
    setTheme({ ...variables, fontFamily: computed.fontFamily, color: computed.color });
  }, [anchor]);
  useLayoutEffect(() => {
    if (!host) return;
    const place = () => {
      const el = anchor.current;
      const pop = box.current;
      if (!el || !pop) return;
      const r = el.getBoundingClientRect();
      const vp = window.visualViewport;
      const leftEdge = vp?.offsetLeft ?? 0;
      const topEdge = vp?.offsetTop ?? 0;
      const width = vp?.width ?? window.innerWidth;
      const height = vp?.height ?? window.innerHeight;
      let visibleLeft = leftEdge, visibleTop = topEdge, visibleRight = leftEdge + width, visibleBottom = topEdge + height;
      // body portal이 조상 스크롤 영역에서 사라진 입력에 붙은 채 남지 않도록
      // viewport와 각 clipping ancestor의 실제 내부 영역을 교차한다.
      for (let parent = el.parentElement; parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        const clipped = /^(auto|scroll|hidden|clip)$/;
        const pr = parent.getBoundingClientRect();
        if (clipped.test(style.overflowX)) {
          visibleLeft = Math.max(visibleLeft, pr.left + parent.clientLeft);
          visibleRight = Math.min(visibleRight, pr.left + parent.clientLeft + parent.clientWidth);
        }
        if (clipped.test(style.overflowY)) {
          visibleTop = Math.max(visibleTop, pr.top + parent.clientTop);
          visibleBottom = Math.min(visibleBottom, pr.top + parent.clientTop + parent.clientHeight);
        }
      }
      if (r.bottom <= visibleTop || r.top >= visibleBottom || r.right <= visibleLeft || r.left >= visibleRight) { onClose(); return; }
      const mobile = window.matchMedia("(max-width:767px)").matches;
      pop.style.maxHeight = `${Math.max(0, height - 16)}px`;
      if (mobile) {
        setPos({ top: topEdge + height - pop.offsetHeight, left: leftEdge });
        return;
      }
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      const left = Math.max(leftEdge + 8, Math.min(r.left, leftEdge + width - w - 8));
      const below = topEdge + height - r.bottom;
      const top = below >= h + 12 ? r.bottom + 4 : Math.max(topEdge + 8, Math.min(r.top - h - 4, topEdge + height - h - 8));
      setPos({ top, left });
    };
    place();
    const resize = new ResizeObserver(place);
    if (anchor.current) resize.observe(anchor.current);
    if (box.current) resize.observe(box.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [anchor, host, onClose]);
  const restore = () => { onClose(); opener.current?.focus(); };
  useEffect(() => {
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        opener.current?.focus();
      }
      // 입력 → portal 이동도 document capture에서 처리한다. 부모 모달의
      // document Tab trap보다 먼저 옮겨야 portal 밖이라고 되돌리지 않는다.
      if (e.key === "Tab" && !e.shiftKey && anchor.current?.contains(document.activeElement)) {
        const target = box.current?.querySelector<HTMLElement>(".dt-day[tabindex='0']:not(:disabled),.dt-time-options button[aria-pressed='true']:not(:disabled)")
          ?? Array.from(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled)") ?? []).find((el) => el.getClientRects().length > 0);
        if (target) { e.preventDefault(); e.stopPropagation(); target.focus(); }
      }
      // body portal이 부모 모달 밖에 있어도 모달의 Tab trap이 포커스를 빼앗지 않는다.
      if (e.key === "Tab" && box.current?.contains(document.activeElement)) {
        e.stopPropagation();
        const list = Array.from(box.current.querySelectorAll<HTMLElement>("button:not(:disabled):not([tabindex='-1']),input:not(:disabled),select:not(:disabled)"))
          .filter((el) => el.getClientRects().length > 0);
        if ((e.shiftKey && document.activeElement === list[0]) || (!e.shiftKey && document.activeElement === list.at(-1))) {
          e.preventDefault();
          onClose();
          opener.current?.focus();
        }
      }
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);
  if (!host) return null;
  return createPortal(
    <div className={`dt-layer ${scope}`} style={theme}>
      <div className="dt-dim" aria-hidden="true" />
      <div id={id} className="dt-pop" ref={box} role="dialog" aria-label={label}
        onBlur={() => leavePicker(anchor.current, id, onClose)}
        onKeyDown={(e) => {
          if (e.key !== "Tab") return;
          const list = Array.from(box.current?.querySelectorAll<HTMLElement>("button:not(:disabled):not([tabindex='-1'])") ?? []);
          if ((e.shiftKey && document.activeElement === list[0]) || (!e.shiftKey && document.activeElement === list.at(-1))) {
            e.preventDefault();
            e.stopPropagation();
            restore();
          }
        }} style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}>
        <div className="dt-sheet-head"><b>{label}</b><button type="button" className="dt-nav" aria-label="달력 닫기" onClick={restore}>×</button></div>
        {children}
      </div>
    </div>, host
  );
}

// 칸: 텍스트 입력(직접 입력 가능) + 달력 아이콘. 칸 어디를 눌러도 열린다
function useFieldState(value: string, onCommit: (iso: string) => void) {
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? formatDateInput(value);
  const change = (raw: string) => {
    setText(raw);
    // 직접 입력은 범위(min·max) 밖이어도 값으로 받는다(범위 오류는 화면이 안내). 달력에서는 범위 밖을 고를 수 없다
    const iso = parseDateInput(raw);
    if (iso) onCommit(iso);
    else if (raw.trim() === "") onCommit("");
  };
  const settle = () => {
    // 칸을 떠날 때: 비웠으면 값 비움, 잘못 쓴 글자는 마지막 값으로 되돌림
    if (text !== null && text.trim() === "" && value) onCommit("");
    setText(null);
  };
  return { shown, change, settle, editing: text !== null };
}

export function DatePicker({ value, onChange, tone = "admin", ...p }: FieldProps & { value: string; onChange: (v: string) => void }) {
  const t = TEXT[tone];
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(value || todayKst());
  const field = useFieldState(value, onChange);
  const inputRef = useRef<HTMLInputElement>(null);
  const labelId = useId();
  const dialogId = useId();
  const close = useCallback(() => setOpen(false), []);
  // 포커스가 칸·달력 밖으로 나가면(Tab 등) 닫는다
  const leave = () => leavePicker(anchor.current, dialogId, close);
  const openIt = () => {
    if (p.disabled || p.readOnly) return;
    setCursor(value || p.max || todayKst());
    setOpen(true);
  };
  const parsed = parseDateInput(field.shown);
  const invalid = field.shown.trim() !== "" && (!parsed || !inRange(parsed, p.min, p.max));
  const error = tone === "shop" ? "선택 가능한 날짜를 올바르게 입력해 주세요." : "선택 가능한 날짜를 올바르게 입력하십시오.";
  useEffect(() => { inputRef.current?.setCustomValidity(invalid ? error : ""); }, [invalid, error]);
  return (
    <span className={`dt-wrap${p.className ? ` ${p.className}` : ""}`} ref={anchor}>
      <input
        ref={inputRef}
        id={p.id}
        className={`inp dt${invalid || p["aria-invalid"] ? " is-error" : ""}`}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={p.placeholder ?? t.placeholder}
        aria-label={p["aria-label"]}
        aria-invalid={invalid || p["aria-invalid"] || undefined}
        aria-haspopup="dialog"
        aria-controls={open ? dialogId : undefined}
        aria-expanded={open}
        disabled={p.disabled}
        readOnly={p.readOnly}
        value={field.shown}
        onClick={openIt}
        onChange={(e) => field.change(e.target.value)}
        onBlur={() => {
          field.settle();
          leave();
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) openIt();
            else enterCalendar(dialogId);
          } else if (e.key === "Enter") {
            e.preventDefault();
            if (field.editing) {
              const iso = parseDateInput(field.shown);
              if (iso) { onChange(iso); field.settle(); close(); }
            } else if (!open) openIt();
            else enterCalendar(dialogId);
          } else if (e.key === "Tab" && open && !e.shiftKey) {
            e.preventDefault();
            enterCalendar(dialogId);
          }
        }}
      />
      <span className="dt-ico" aria-hidden="true" onMouseDown={(e) => e.preventDefault()} onClick={openIt}>
        <CalIcon />
      </span>
      {open && (
        <Popover id={dialogId} anchor={anchor} onClose={close} label={`${p["aria-label"] ?? t.cal} 달력`}>
          <span id={labelId} className="sr-only">
            {t.pickOne}
          </span>
          <Calendar cursor={cursor} setCursor={setCursor} from={value} min={p.min} max={p.max} tone={tone} onPick={(iso) => { onChange(iso); setOpen(false); anchor.current?.querySelector("input")?.focus(); }} />
          <div className="dt-foot">
            <span className="dt-hint">{t.pickOne}</span>
            <button type="button" className="btn btn-out btn-sm btn-w-sm" onClick={() => { onChange(""); setOpen(false); }}>
              {t.reset}
            </button>
            <button type="button" className="btn btn-sm btn-w-sm" onClick={close}>
              {t.apply}
            </button>
          </div>
        </Popover>
      )}
    </span>
  );
}

// 기간: 시작일 ~ 종료일 두 칸 + 달력 하나(두 번 눌러 [적용]) + 빠른 선택(오늘·7일·1개월·3개월·전체)
export function DateRangePicker({ from, to, onChange, fromLabel, toLabel, quick = false, tone = "admin", min, max, disabled, readOnly, className }: {
  from: string; to: string; onChange: (r: { from: string; to: string }) => void; fromLabel?: string; toLabel?: string; quick?: boolean; tone?: Tone; min?: string; max?: string; disabled?: boolean; readOnly?: boolean; className?: string;
}) {
  const t = TEXT[tone];
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ from, to });
  const [hover, setHover] = useState<string | undefined>();
  const [cursor, setCursor] = useState(from || todayKst());
  const fromField = useFieldState(from, (iso) => onChange({ from: iso, to }));
  const toField = useFieldState(to, (iso) => onChange({ from, to: iso }));
  const dialogId = useId();
  const errorId = useId();
  const reverse = !!from && !!to && to < from;
  const outside = [fromField.shown, toField.shown].some((s) => !!s.trim() && (!parseDateInput(s) || !inRange(parseDateInput(s)!, min, max)));
  const error = reverse ? (tone === "shop" ? "종료일은 시작일 이후로 골라 주세요." : "종료일은 시작일 이후로 선택하십시오.") : outside ? (tone === "shop" ? "선택 가능한 날짜를 올바르게 입력해 주세요." : "선택 가능한 날짜를 올바르게 입력하십시오.") : "";
  useEffect(() => {
    anchor.current?.querySelectorAll<HTMLInputElement>("input").forEach((input) => input.setCustomValidity(error));
  }, [error]);
  const close = useCallback(() => setOpen(false), []);
  const leave = () => leavePicker(anchor.current, dialogId, close);
  const openIt = () => {
    if (disabled || readOnly) return;
    setDraft({ from, to });
    setHover(undefined);
    setCursor(from || to || max || todayKst());
    setOpen(true);
  };
  // 두 번 눌러 고른다: 첫 번째는 시작일(끝은 비움), 시작일 앞은 고를 수 없다(DS-DATEPICKER ④).
  const pick = (iso: string) => {
    if (!draft.from || draft.to) setDraft({ from: iso, to: "" });
    else if (iso >= draft.from) setDraft({ from: draft.from, to: iso });
  };
  const apply = () => {
    if (draft.from && !draft.to) onChange({ from: draft.from, to: draft.from });
    else onChange(draft);
    setOpen(false);
  };
  const q = activeQuick({ from, to });
  const sum = draft.from && draft.to ? `${formatDateInput(draft.from)} ~ ${formatDateInput(draft.to)} · ${daysBetween(draft.from, draft.to) + 1}일` : draft.from ? t.pickEnd : t.pickOne;
  const input = (which: "from" | "to") => {
    const f = which === "from" ? fromField : toField;
    const label = which === "from" ? (fromLabel ?? t.from) : (toLabel ?? t.to);
    return (
      <span className="dt-wrap dt-range-i">
        <input
          className="inp dt"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder={which === "from" ? t.from : t.to}
          aria-label={label}
          aria-haspopup="dialog"
        aria-controls={open ? dialogId : undefined}
          aria-expanded={open}
          disabled={disabled}
          readOnly={readOnly}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? errorId : undefined}
          value={f.shown}
          onClick={openIt}
          onChange={(e) => f.change(e.target.value)}
          onBlur={() => {
            f.settle();
            leave();
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "Enter") {
              e.preventDefault();
              if (!open) openIt();
              else enterCalendar(dialogId);
            } else if (e.key === "Tab" && open && !e.shiftKey) {
              e.preventDefault();
              enterCalendar(dialogId);
            }
          }}
        />
        <span className="dt-ico" aria-hidden="true" onMouseDown={(e) => e.preventDefault()} onClick={openIt}>
          <CalIcon />
        </span>
      </span>
    );
  };
  return (
    <span className={`dt-range${className ? ` ${className}` : ""}`} ref={anchor}>
      {quick && (
        <span className="dt-quick" role="group" aria-label="기간 빠른 선택">
          {QUICK_RANGES.map((k) => (
            <button key={k.key} type="button" className={`chip${q === k.key ? " on" : ""}`} aria-pressed={q === k.key} disabled={disabled || readOnly} onClick={() => onChange(quickRange(k.key as QuickKey))}>
              {k.label}
            </button>
          ))}
        </span>
      )}
      {input("from")}
      <span aria-hidden="true" className="dt-tilde">
        ~
      </span>
      {input("to")}
      {error && <span id={errorId} className="dt-time-error" role="alert">{error}</span>}
      {open && (
        <Popover id={dialogId} anchor={anchor} onClose={close} label="기간 달력">
          <Calendar cursor={cursor} setCursor={setCursor} from={draft.from} to={draft.to} hover={draft.from && !draft.to ? hover : undefined} min={draft.from && !draft.to && (!min || draft.from > min) ? draft.from : min} max={max} tone={tone} onPick={pick} onHover={setHover} />
          <div className="dt-foot">
            <span className="dt-hint">{sum}</span>
            <button type="button" className="btn btn-out btn-sm btn-w-sm" onClick={() => { onChange({ from: "", to: "" }); setOpen(false); }}>
              {t.reset}
            </button>
            <button type="button" className="btn btn-sm btn-w-sm" disabled={!draft.from} onClick={apply}>
              {t.apply}
            </button>
          </div>
        </Popover>
      )}
    </span>
  );
}

// 단독 시각 선택: HH:mm, 직접 입력과 30분 단위 선택을 함께 지원한다.
export function TimePicker({ value, onChange, tone = "admin", ...p }: FieldProps & { value: string; onChange: (v: string) => void }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const dialogId = useId();
  const errorId = useId();
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => { setText(null); }, [value]);
  const shown = text ?? value;
  const parsed = parseTimeInput(shown);
  const invalid = shown.trim() !== "" && (!parsed || !inRange(parsed, p.min, p.max));
  const message = tone === "shop"
    ? `시각을 ${p.min ?? "00:00"}~${p.max ?? "23:59"}로 입력해 주세요.`
    : `시각을 ${p.min ?? "00:00"}~${p.max ?? "23:59"}로 입력하십시오.`;
  useEffect(() => { input.current?.setCustomValidity(invalid ? message : ""); }, [invalid, message]);
  const openIt = () => { if (!p.disabled && !p.readOnly) setOpen(true); };
  const commit = (raw: string) => {
    setText(raw);
    const tm = parseTimeInput(raw);
    if (tm && inRange(tm, p.min, p.max)) onChange(tm);
    else if (raw.trim() === "") onChange("");
  };
  const focusOption = () => document.getElementById(dialogId)?.querySelector<HTMLButtonElement>(".dt-time-options button[aria-pressed='true']:not(:disabled),.dt-time-options button:not(:disabled)")?.focus();
  const times = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);
  // 10:15처럼 경계가 30분 단위가 아니어도 정확히 선택할 수 있게 한다.
  const options = [...new Set([...times, p.min, p.max, parseTimeInput(value) ?? undefined].filter((tm): tm is string => !!tm && !!parseTimeInput(tm)))].sort();
  return (
    <span className="dt-time-field">
      <span className={`dt-wrap dt-time-wrap${p.className ? ` ${p.className}` : ""}`} ref={anchor}>
        <input ref={input} id={p.id} className={`inp dt-time${invalid || p["aria-invalid"] ? " is-error" : ""}`} type="text" inputMode="numeric" autoComplete="off"
          placeholder={p.placeholder ?? "HH:mm"} aria-label={p["aria-label"] ?? "시각"} aria-invalid={invalid || p["aria-invalid"] || undefined}
          aria-describedby={invalid ? errorId : undefined} aria-haspopup="dialog" aria-controls={open ? dialogId : undefined} aria-expanded={open}
          disabled={p.disabled} readOnly={p.readOnly} value={shown} onClick={openIt} onChange={(e) => commit(e.target.value)}
          onBlur={() => { if (parsed && !invalid) setText(null); leavePicker(anchor.current, dialogId, close); }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === "ArrowDown") {
              e.preventDefault();
              if (!open) openIt(); else focusOption();
            } else if (e.key === "Tab" && open && !e.shiftKey) { e.preventDefault(); focusOption(); }
          }} />
        <span className="dt-ico" aria-hidden="true" onMouseDown={(e) => e.preventDefault()} onClick={openIt}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
        </span>
        {open && <Popover id={dialogId} anchor={anchor} onClose={close} label={`${p["aria-label"] ?? "시각"} 선택`}>
          <div className="dt-time-options" role="group" aria-label="시각 선택">
            {options.map((tm) => <button type="button" key={tm} disabled={!inRange(tm, p.min, p.max)} aria-pressed={tm === value}
              onKeyDown={(e) => {
                const offset = ({ ArrowRight: 1, ArrowLeft: -1, ArrowDown: 4, ArrowUp: -4 } as Record<string, number>)[e.key];
                if (!offset) return;
                e.preventDefault();
                const buttons = Array.from(e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
                buttons[Math.max(0, Math.min(buttons.length - 1, buttons.indexOf(e.currentTarget) + offset))]?.focus();
              }} onClick={() => { onChange(tm); setText(null); close(); input.current?.focus(); }}>{tm}</button>)}
          </div>
          <div className="dt-foot"><span className="dt-hint">HH:mm</span><button type="button" className="btn btn-out btn-sm btn-w-sm" onClick={() => { onChange(""); setText(null); close(); input.current?.focus(); }}>{TEXT[tone].reset}</button><button type="button" className="btn btn-sm btn-w-sm" onClick={() => { close(); input.current?.focus(); }}>{TEXT[tone].apply}</button></div>
        </Popover>}
      </span>
      {invalid && <span id={errorId} className="dt-time-error" role="alert">{message}</span>}
    </span>
  );
}

// 날짜+시각 값은 시간대 변환 없이 YYYY-MM-DDTHH:mm(KST)을 보존한다.
export function DateTimePicker({ value, onChange, tone = "admin", minDateTime, maxDateTime, ...p }: FieldProps & { value: string; onChange: (v: string) => void; minDateTime?: string; maxDateTime?: string }) {
  const [date = "", time = ""] = value.split("T");
  const [pendingTime, setPendingTime] = useState("");
  const min = minDateTime ?? p.min;
  const max = maxDateTime ?? p.max;
  const minDay = min?.split("T")[0];
  const maxDay = max?.split("T")[0];
  const timeMin = date === minDay ? min?.split("T")[1] : undefined;
  const timeMax = date === maxDay ? max?.split("T")[1] : undefined;
  const pickDate = (d: string) => {
    if (!d) { setPendingTime(""); onChange(""); return; }
    let tm = time || pendingTime || "00:00";
    // 날짜를 바꿀 때 기존 시각이 그날의 경계 밖이면 가장 가까운 허용 시각으로 맞춘다.
    if (d === minDay && min?.includes("T") && tm < min.split("T")[1]) tm = min.split("T")[1];
    if (d === maxDay && max?.includes("T") && tm > max.split("T")[1]) tm = max.split("T")[1];
    onChange(`${d}T${tm}`);
  };
  return <span className="dt-dt">
    <DatePicker {...p} min={minDay} max={maxDay} tone={tone} value={date} onChange={pickDate} aria-label={p["aria-label"] ? `${p["aria-label"]} 날짜` : undefined} />
    <TimePicker tone={tone} value={time || pendingTime} min={timeMin} max={timeMax} disabled={p.disabled} readOnly={p.readOnly} aria-invalid={p["aria-invalid"]}
      aria-label={p["aria-label"] ? `${p["aria-label"]} 시각` : "시각"}
      onChange={(tm) => { setPendingTime(tm); if (date) onChange(`${date}T${tm || timeMin || "00:00"}`); }} />
  </span>;
}
