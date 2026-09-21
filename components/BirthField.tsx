"use client";

import { useEffect, useId, useState } from "react";
import { DEFAULT_AGE, parseYYMMDD, saveBirth, toYYMMDD, useBirthProfile } from "@/lib/profile";

/** 생년월일 6자리 입력 + 저장 · 저장 즉시 모든 계산기 나이 기준 반영 */
export function BirthField({ large = false }: { large?: boolean }) {
  const id = useId();
  const { birth, age, saved } = useBirthProfile();
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"" | "saved" | "invalid">("");

  useEffect(() => {
    if (birth) setText(toYYMMDD(birth));
  }, [birth?.y, birth?.m, birth?.d]); // eslint-disable-line react-hooks/exhaustive-deps

  function submit() {
    const parsed = parseYYMMDD(text);
    if (!parsed) {
      setStatus("invalid");
      return;
    }
    saveBirth(parsed);
    setStatus("saved");
  }

  const dirty = !birth || text !== toYYMMDD(birth);

  return (
    <div className={large ? "field birthField birthFieldLarge" : "field birthField"}>
      <label htmlFor={id}>생년월일</label>
      <form
        className="birthRow"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          maxLength={6}
          placeholder="900225"
          aria-describedby={`${id}-hint`}
          value={text}
          onChange={(event) => {
            setText(event.target.value.replace(/\D/g, "").slice(0, 6));
            setStatus("");
          }}
        />
        <button type="submit" className="primaryButton" disabled={text.length !== 6 || !dirty}>
          저장
        </button>
      </form>
      <small id={`${id}-hint`} className={status === "invalid" ? "birthHint error" : "birthHint"} aria-live="polite">
        {status === "invalid"
          ? "생년월일 6자리 확인 필요 · 예 900225"
          : saved && birth
            ? `${birth.y}.${String(birth.m).padStart(2, "0")}.${String(birth.d).padStart(2, "0")} · 만 ${age}세 · 전체 계산기 적용${status === "saved" ? " · 저장 완료" : ""}`
            : `YYMMDD 6자리 · 미저장 시 ${DEFAULT_AGE}세 기준`}
      </small>
    </div>
  );
}
