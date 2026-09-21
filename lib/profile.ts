"use client";

import { useSyncExternalStore } from "react";

// 생년월일 · 브라우저 localStorage에만 저장, 모든 계산기 공통 나이 기준
const KEY = "lifeleft.profile.birth";
const EVENT = "lifeleft:profile";
export const DEFAULT_AGE = 36;

export type Birth = { y: number; m: number; d: number };

function read(): string | null {
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

function subscribe(callback: () => void) {
  window.addEventListener("storage", callback);
  window.addEventListener(EVENT, callback);
  return () => {
    window.removeEventListener("storage", callback);
    window.removeEventListener(EVENT, callback);
  };
}

/** YYMMDD → 생년월일. 연도 두 자리가 올해 뒤 두 자리보다 크면 1900년대. 잘못된 날짜·미래 날짜는 null */
export function parseYYMMDD(text: string, today = new Date()): Birth | null {
  if (!/^\d{6}$/.test(text)) return null;
  const yy = Number(text.slice(0, 2));
  const m = Number(text.slice(2, 4));
  const d = Number(text.slice(4, 6));
  const y = yy > today.getFullYear() % 100 ? 1900 + yy : 2000 + yy;
  const date = new Date(y, m - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  if (date > today) return null;
  return { y, m, d };
}

function fromStored(value: string | null): Birth | null {
  if (!value) return null;
  const [y, m, d] = value.split("-").map(Number);
  return y && m && d ? { y, m, d } : null;
}

/** 만 나이 */
export function ageFromBirth(birth: Birth, today = new Date()): number {
  let age = today.getFullYear() - birth.y;
  const beforeBirthday = today.getMonth() + 1 < birth.m || (today.getMonth() + 1 === birth.m && today.getDate() < birth.d);
  if (beforeBirthday) age -= 1;
  return Math.max(0, age);
}

export function toYYMMDD(birth: Birth) {
  return `${String(birth.y % 100).padStart(2, "0")}${String(birth.m).padStart(2, "0")}${String(birth.d).padStart(2, "0")}`;
}

export function saveBirth(birth: Birth) {
  const value = `${birth.y}-${String(birth.m).padStart(2, "0")}-${String(birth.d).padStart(2, "0")}`;
  try {
    window.localStorage.setItem(KEY, value);
  } catch {
    // 저장 불가 환경 · 현재 화면에만 반영
  }
  window.dispatchEvent(new Event(EVENT));
}

/** 공통 생년월일·나이. 미저장 시 기본 나이 */
export function useBirthProfile() {
  const raw = useSyncExternalStore(subscribe, read, () => null);
  const birth = fromStored(raw);
  return { birth, age: birth ? ageFromBirth(birth) : DEFAULT_AGE, saved: Boolean(birth) };
}
