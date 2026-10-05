"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { addDays, addMonths, activeQuick, daysBetween, formatDateInput, monthGrid, parseDateInput, parseTimeInput, quickRange, QUICK_RANGES, todayKst, type QuickKey } from "../../lib/client/dateInput";

// 공통 날짜 선택(DS-DATEPICKER 정본, 대표님 지시 2026-10-06 「네이버식」): 기본 input type=date를 대체한다. 화면마다 따로 만들지 않는다.
// - 칸: 값 「2026.10.05」, 빈 칸 「날짜 선택」, 오른쪽 달력 아이콘, 칸 어디를 눌러도 달력이 열린다(직접 입력·Tab·키보드도 됨). 높이 40(관리자)·44(폼)·48(휴대폰)은 .inp 규격을 따른다
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
const enterCalendar = () => document.querySelector<HTMLButtonElement>('.dt-pop .dt-day[tabindex="0"]')?.focus();
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
  const stop = grid.flat().find((c) => c.iso === from && c.inMonth)?.iso ?? grid.flat().find((c) => c.iso === today && c.inMonth)?.iso ?? grid.flat().find((c) => c.inMonth)?.iso;
  const key = (e: React.KeyboardEvent, iso: string) => {
    const step: Record<string, string> = { ArrowLeft: addDays(iso, -1), ArrowRight: addDays(iso, 1), ArrowUp: addDays(iso, -7), ArrowDown: addDays(iso, 7), PageUp: addMonths(iso, -1), PageDown: addMonths(iso, 1) };
    const next = step[e.key];
    if (!next) return;
    e.preventDefault();
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
      <div className="dt-grid" role="grid" aria-label={`${y}년 ${m}월`}>
        {grid.flat().map((c, i) => {
          const ok = inRange(c.iso, min, max);
          const sel = c.iso === from || c.iso === to;
          const mid = lo && hi && c.iso > lo && c.iso < hi;
          const cls = ["dt-day", i % 7 === 0 ? "sun" : i % 7 === 6 ? "sat" : "", c.inMonth ? "" : "out", sel ? "sel" : "", mid ? "mid" : "", c.iso === today ? "today" : "", ok ? "" : "off"].filter(Boolean).join(" ");
          return (
            <button key={c.iso} type="button" data-iso={c.iso} className={cls} disabled={!ok} aria-pressed={sel} aria-label={`${c.iso.replace(/-/g, ".")}`} tabIndex={c.iso === stop ? 0 : -1} onClick={() => onPick(c.iso)} onMouseEnter={() => onHover?.(c.iso)} onKeyDown={(e) => key(e, c.iso)}>
              {c.day}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// 팝오버: 칸 아래에 붙고, 휴대폰은 아래 시트. 바깥 클릭·Esc는 닫기
function Popover({ anchor, onClose, children, label }: { anchor: React.RefObject<HTMLElement | null>; onClose: () => void; children: React.ReactNode; label: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    const el = anchor.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = 320;
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    const below = window.innerHeight - r.bottom;
    setPos({ top: below > 380 ? r.bottom + 4 : Math.max(8, r.top - 4 - 372), left });
  }, [anchor]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor.current?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        const input = anchor.current?.querySelector("input") as HTMLInputElement | null;
        if (input) {
          input.dataset.skipOpen = "1";
          input.focus();
        }
      }
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key, true);
    };
  }, [anchor, onClose]);
  return (
    <div className="dt-layer">
      <div className="dt-dim" aria-hidden="true" />
      <div className="dt-pop" ref={box} role="dialog" aria-label={label} style={pos ? { top: pos.top, left: pos.left } : undefined}>
        {children}
      </div>
    </div>
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
  const labelId = useId();
  const close = useCallback(() => setOpen(false), []);
  const openIt = () => {
    if (p.disabled || p.readOnly) return;
    setCursor(value || p.max || todayKst());
    setOpen(true);
  };
  const invalid = field.editing && field.shown.trim() !== "" && !parseDateInput(field.shown);
  return (
    <span className={`dt-wrap${p.className ? ` ${p.className}` : ""}`} ref={anchor}>
      <input
        id={p.id}
        className={`inp dt${invalid || p["aria-invalid"] ? " is-error" : ""}`}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={p.placeholder ?? t.placeholder}
        aria-label={p["aria-label"]}
        aria-invalid={invalid || p["aria-invalid"] || undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={p.disabled}
        readOnly={p.readOnly}
        value={field.shown}
        onClick={openIt}
        onFocus={(e) => (e.currentTarget.dataset.skipOpen ? delete e.currentTarget.dataset.skipOpen : openIt())}
        onChange={(e) => field.change(e.target.value)}
        onBlur={field.settle}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) openIt();
            else enterCalendar();
          } else if (e.key === "Enter") {
            const iso = parseDateInput(field.shown);
            if (iso) {
              e.preventDefault();
              onChange(iso);
              setOpen(false);
            }
          }
        }}
      />
      <span className="dt-ico" aria-hidden="true" onMouseDown={(e) => e.preventDefault()} onClick={openIt}>
        <CalIcon />
      </span>
      {open && (
        <Popover anchor={anchor} onClose={close} label={p["aria-label"] ?? t.cal}>
          <span id={labelId} className="sr-only">
            {t.pickOne}
          </span>
          <Calendar cursor={cursor} setCursor={setCursor} from={value} min={p.min} max={p.max} tone={tone} onPick={(iso) => { onChange(iso); setOpen(false); }} />
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
export function DateRangePicker({ from, to, onChange, fromLabel, toLabel, quick = false, tone = "admin", min, max, disabled, className }: {
  from: string; to: string; onChange: (r: { from: string; to: string }) => void; fromLabel?: string; toLabel?: string; quick?: boolean; tone?: Tone; min?: string; max?: string; disabled?: boolean; className?: string;
}) {
  const t = TEXT[tone];
  const anchor = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({ from, to });
  const [hover, setHover] = useState<string | undefined>();
  const [cursor, setCursor] = useState(from || todayKst());
  const fromField = useFieldState(from, (iso) => onChange({ from: iso, to }));
  const toField = useFieldState(to, (iso) => onChange({ from, to: iso }));
  const close = useCallback(() => setOpen(false), []);
  const openIt = () => {
    if (disabled) return;
    setDraft({ from, to });
    setHover(undefined);
    setCursor(from || to || max || todayKst());
    setOpen(true);
  };
  // 두 번 눌러 고른다: 첫 번째는 시작일(끝은 비움), 두 번째는 끝(앞이면 시작과 바꿈)
  const pick = (iso: string) => {
    if (!draft.from || draft.to) setDraft({ from: iso, to: "" });
    else setDraft(iso < draft.from ? { from: iso, to: draft.from } : { from: draft.from, to: iso });
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
          aria-expanded={open}
          disabled={disabled}
          value={f.shown}
          onClick={openIt}
          onFocus={(e) => (e.currentTarget.dataset.skipOpen ? delete e.currentTarget.dataset.skipOpen : !open && openIt())}
          onChange={(e) => f.change(e.target.value)}
          onBlur={f.settle}
          onKeyDown={(e) => {
            if (e.key !== "ArrowDown") return;
            e.preventDefault();
            if (!open) openIt();
            else enterCalendar();
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
            <button key={k.key} type="button" className={`chip${q === k.key ? " on" : ""}`} aria-pressed={q === k.key} disabled={disabled} onClick={() => onChange(quickRange(k.key as QuickKey))}>
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
      {open && (
        <Popover anchor={anchor} onClose={close} label="기간 선택">
          <Calendar cursor={cursor} setCursor={setCursor} from={draft.from} to={draft.to} hover={draft.from && !draft.to ? hover : undefined} min={min} max={max} tone={tone} onPick={pick} onHover={setHover} />
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

// 날짜+시각(기존 datetime-local 대체): 「YYYY-MM-DDTHH:mm」. 날짜는 DatePicker, 시각은 「HH:mm」 칸
export function DateTimePicker({ value, onChange, tone = "admin", ...p }: FieldProps & { value: string; onChange: (v: string) => void }) {
  const [date, time] = value ? value.split("T") : ["", ""];
  const [text, setText] = useState<string | null>(null);
  const emit = (d: string, tm: string) => onChange(d ? `${d}T${tm || "00:00"}` : "");
  return (
    <span className="dt-dt">
      <DatePicker {...p} tone={tone} value={date ?? ""} onChange={(d) => emit(d, time ?? "")} aria-label={p["aria-label"] ? `${p["aria-label"]} 날짜` : undefined} />
      <input
        className="inp dt-time"
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder="00:00"
        aria-label={p["aria-label"] ? `${p["aria-label"]} 시각` : "시각"}
        disabled={p.disabled}
        readOnly={p.readOnly}
        value={text ?? time ?? ""}
        onChange={(e) => {
          setText(e.target.value);
          const tm = parseTimeInput(e.target.value);
          if (tm && date) emit(date, tm);
        }}
        onBlur={() => setText(null)}
      />
    </span>
  );
}
