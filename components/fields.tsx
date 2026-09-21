"use client";

import { useId, useLayoutEffect, useRef, type ChangeEvent } from "react";
import { formatNumber, formatWon, parseDigits } from "@/lib/format";

type SelectProps = {
  label: string;
  value: number;
  options: number[];
  onChange: (value: number) => void;
  unit?: string;
  format?: (value: number) => string;
};

/** 선택형 값 · 네이티브 select(모바일 휠 UI) */
export function SelectField({ label, value, options, onChange, unit = "", format }: SelectProps) {
  const id = useId();
  const list = options.includes(value) ? options : [...options, value].sort((a, b) => a - b);
  const text = (option: number) => (format ? format(option) : `${formatNumber(option, 1)}${unit}`);

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <span className="selectWrap">
        <select id={id} value={value} onChange={(event) => onChange(Number(event.target.value))}>
          {list.map((option) => (
            <option key={option} value={option}>
              {text(option)}
            </option>
          ))}
        </select>
      </span>
    </div>
  );
}

type NumberProps = {
  label: string;
  value: number;
  onChange: (value: number) => void;
  unit?: string;
  money?: boolean;
  max?: number;
};

/** 직접 입력 숫자 · 천 단위 콤마, 금액은 만원 환산 표기 */
export function NumberField({ label, value, onChange, unit = "", money = false, max = 1e13 }: NumberProps) {
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  const caretFromRight = useRef<number | null>(null);

  useLayoutEffect(() => {
    const input = ref.current;
    if (!input || caretFromRight.current === null || document.activeElement !== input) return;
    const text = input.value;
    let digitsSeen = 0;
    let position = text.length;
    while (position > 0 && digitsSeen < caretFromRight.current) {
      if (/\d/.test(text[position - 1])) digitsSeen += 1;
      position -= 1;
    }
    input.setSelectionRange(position, position);
    caretFromRight.current = null;
  });

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const { value: raw, selectionStart } = event.target;
    const tail = raw.slice(selectionStart ?? raw.length);
    caretFromRight.current = tail.replace(/[^\d]/g, "").length;
    onChange(Math.min(max, parseDigits(raw)));
  }

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <span className="numberWrap">
        <input
          ref={ref}
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={formatNumber(value)}
          onChange={handleChange}
          onFocus={(event) => event.currentTarget.select()}
        />
        {unit ? <span className="fieldUnit">{unit}</span> : null}
      </span>
      {money && value >= 1_000_000 ? <small className="fieldHint">{formatWon(value)}</small> : null}
    </div>
  );
}
