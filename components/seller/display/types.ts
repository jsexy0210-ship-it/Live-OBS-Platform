import { useEffect, useRef, useState } from "react";

// 상품 진열(SA-016) 화면이 쓰는 서버 응답 모양과 문구. API: /api/seller/display(조회), /sections·/settings·/recommended(저장), /api/seller/categories/[id]/products(카테고리 안 순서).
export type Kind = "RECOMMENDED" | "NEW" | "CATEGORY" | "LIVE" | "BEST" | "SALE" | "HALL_OF_FAME";
export type Section = { id?: string | null; kind: Kind; categoryId: string | null; title: string; visible: boolean; itemCount: number };
export type ListSort = "new" | "recommended" | "popular" | "low" | "high";
export type Options = { soldOutLast: boolean; hideSoldOut: boolean; liveFirst: boolean };
export type Status = "DRAFT" | "ON_SALE" | "SOLD_OUT" | "HIDDEN";
export type RecItem = { productId: string; code: string; name: string; status: Status; deleted: boolean; thumbnailUrl: string | null };
export type Display = { listSort: ListSort; options: Options; sections: Section[]; recommended: RecItem[] };
export type CatItem = { productId: string; code: string; name: string; status: Status; sortOrder: number; thumbnailUrl: string | null };
export type CategoryNode = { id: string; name: string; visible: boolean; children: { id: string; name: string; visible: boolean }[] };

export const MAX_SECTIONS = 10;
export const MAX_RECOMMENDED = 20;
export const TITLE_MAX = 30;

export const KIND_INFO: Record<Kind, { label: string; basis: string }> = {
  RECOMMENDED: { label: "추천 상품", basis: "직접 고른 순서 (아래 「추천 상품」)" },
  NEW: { label: "신상품", basis: "최근 등록한 순서 · 자동" },
  CATEGORY: { label: "카테고리", basis: "카테고리의 진열 순서" },
  LIVE: { label: "방송 상품", basis: "지금 방송에서 주문된 상품 · 자동" },
  BEST: { label: "베스트", basis: "최근 30일 판매량 · 자동" },
  SALE: { label: "할인 중", basis: "이벤트 할인 기간 중 · 자동" },
  HALL_OF_FAME: { label: "명예의 전당", basis: "HIT 카드가 나온 상품 · 자동" },
};
export const SORT_LABEL: Record<ListSort, string> = { recommended: "진열 순서 (직접 지정)", new: "최신 등록순", popular: "판매량순", low: "낮은 가격순", high: "높은 가격순" };
export const STATUS_BADGE: Record<Status, { label: string; cls: string }> = {
  ON_SALE: { label: "판매 중", cls: "b-done" },
  SOLD_OUT: { label: "품절", cls: "b-fail" },
  HIDDEN: { label: "숨김", cls: "b-gray nodot" },
  DRAFT: { label: "임시 저장", cls: "b-wait nodot" },
};

// 서버 값으로 만든 초안. 서버 값이 바뀌면(저장·새로 고침) 초안도 그 값으로 다시 맞춘다.
export function useDraft<T>(server: T): [T, (v: T | ((p: T) => T)) => void, boolean] {
  const key = JSON.stringify(server);
  const [draft, setDraft] = useState<T>(server);
  const last = useRef(key);
  useEffect(() => {
    if (last.current !== key) {
      last.current = key;
      setDraft(server);
    }
  }, [key, server]);
  return [draft, setDraft, JSON.stringify(draft) !== key];
}

export function moved<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  next.splice(to, 0, next.splice(from, 1)[0]);
  return next;
}

// 서버가 준 문구가 있으면 그대로, 없으면(연결 끊김 등) 안내 문구
export const failText = (r: { status: number; message?: string }, fallback: string) => r.message ?? (r.status === 0 ? "연결이 끊겼습니다. 인터넷 연결을 확인해 주십시오" : fallback);
