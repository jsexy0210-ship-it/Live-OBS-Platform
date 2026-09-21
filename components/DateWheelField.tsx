"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";

const ITEM = 44;
const PAD = 2; // 선택줄 위·아래 여백 행 수

type Parts = { y: number; m: number; d: number };

function parse(value: string, fallback: Parts): Parts {
  const [y, m, d] = value.split("-").map(Number);
  return { y: y || fallback.y, m: m || fallback.m, d: d || 1 };
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const daysIn = (y: number, m: number) => new Date(y, m, 0).getDate();

function Wheel({ label, items, value, onChange, suffix }: {
  label: string;
  items: number[];
  value: number;
  onChange: (value: number) => void;
  suffix: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const index = Math.max(0, items.indexOf(value));

  useEffect(() => {
    const el = ref.current;
    if (el && Math.round(el.scrollTop / ITEM) !== index) el.scrollTo({ top: index * ITEM });
  }, [index]);

  function handleScroll() {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const el = ref.current;
      if (!el) return;
      const next = items[Math.min(items.length - 1, Math.max(0, Math.round(el.scrollTop / ITEM)))];
      if (next !== value) onChange(next);
    }, 90);
  }

  return (
    <div
      ref={ref}
      className="wheel"
      role="listbox"
      aria-label={label}
      tabIndex={0}
      onScroll={handleScroll}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const next = items[Math.min(items.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))];
          onChange(next);
        }
      }}
    >
      {Array.from({ length: PAD }, (_, i) => <div className="wheelPad" key={`t${i}`} />)}
      {items.map((item, i) => (
        <div
          key={item}
          role="option"
          aria-selected={i === index}
          className={i === index ? "wheelItem active" : "wheelItem"}
          onClick={() => ref.current?.scrollTo({ top: i * ITEM, behavior: "smooth" })}
        >
          {suffix === "년" ? item : pad2(item)}
          {suffix}
        </div>
      ))}
      {Array.from({ length: PAD }, (_, i) => <div className="wheelPad" key={`b${i}`} />)}
    </div>
  );
}

type Props = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  minYear?: number;
};

/** 날짜 선택 · 입력 영역 전체 클릭 → 년/월/일 3단 휠 */
export function DateWheelField({ label, value, onChange, minYear = 2000 }: Props) {
  const id = useId();
  const now = new Date();
  const today = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  const current = parse(value, today);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Parts>(current);
  const trigger = useRef<HTMLButtonElement>(null);
  const sheet = useRef<HTMLDivElement>(null);

  const years = Array.from({ length: today.y - minYear + 1 }, (_, i) => minYear + i);
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const days = Array.from({ length: daysIn(draft.y, draft.m) }, (_, i) => i + 1);

  const close = useCallback(() => {
    setOpen(false);
    trigger.current?.focus();
  }, []);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sheet.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  function update(patch: Partial<Parts>) {
    setDraft((prev) => {
      const next = { ...prev, ...patch };
      next.d = Math.min(next.d, daysIn(next.y, next.m));
      return next;
    });
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <button
        ref={trigger}
        id={id}
        type="button"
        className="dateField"
        aria-haspopup="dialog"
        onClick={() => {
          setDraft(current);
          setOpen(true);
        }}
      >
        <span>
          {current.y}년 {pad2(current.m)}월 {pad2(current.d)}일
        </span>
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="5" width="18" height="16" />
          <path d="M3 10h18M8 3v4M16 3v4" />
        </svg>
      </button>

      {open ? (
        <div className="sheetBackdrop" onClick={close}>
          <div
            ref={sheet}
            className="sheet"
            role="dialog"
            aria-modal="true"
            aria-label={`${label} 선택`}
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="sheetHead">
              <button type="button" className="sheetAction" onClick={close}>취소</button>
              <strong>{label}</strong>
              <button
                type="button"
                className="sheetAction confirm"
                onClick={() => {
                  onChange(`${draft.y}-${pad2(draft.m)}-${pad2(draft.d)}`);
                  close();
                }}
              >
                확인
              </button>
            </div>
            <div className="wheels">
              <span className="wheelBand" aria-hidden="true" />
              <Wheel label="년" items={years} value={draft.y} onChange={(y) => update({ y })} suffix="년" />
              <Wheel label="월" items={months} value={draft.m} onChange={(m) => update({ m })} suffix="월" />
              <Wheel label="일" items={days} value={draft.d} onChange={(d) => update({ d })} suffix="일" />
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
