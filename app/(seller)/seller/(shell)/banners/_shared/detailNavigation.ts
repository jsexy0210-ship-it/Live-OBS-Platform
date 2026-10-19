import { sanitizeNext } from "../../../../../../lib/client/navigation/safeNext";

export function listReturnTo(raw: unknown, list: string): string {
  const safe = sanitizeNext(raw, [list]);
  return safe && new URL(safe, "http://local.invalid").pathname === list ? safe : list;
}

export function detailHref(path: string, extra: Record<string, string> = {}): string {
  return `${path}?${new URLSearchParams({ ...extra, returnTo: location.pathname + location.search })}`;
}

// 상세에서 목록으로 돌아온 직후 한 번만 보여 주는 기존 처리 결과입니다.
const results = new Map<string, string>();
export const setDetailResult = (list: string, text: string) => { results.set(list, text); };
export const takeDetailResult = (list: string) => { const text = results.get(list); results.delete(list); return text; };
