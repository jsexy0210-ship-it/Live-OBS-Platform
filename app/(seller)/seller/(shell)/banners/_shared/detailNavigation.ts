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

// 금융 목록과 같은 보조 복귀 정보: 본문·검색어 원문 없이 같은 사용자·조건의 커서만 한 번 소비합니다.
type CursorMenu = "buyer-inquiries" | "reviews";
type CursorPosition = { page: number; cursors: (string | undefined)[] };
export async function cursorScope(menu: CursorMenu, sellerId: string, userId: string, signature: string): Promise<string> {
  try { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([menu, sellerId, userId, signature])))), n => n.toString(16).padStart(2, "0")).join(""); } catch { return ""; }
}
export function rememberCursorPosition(menu: CursorMenu, scope: string, position: CursorPosition, storage?: Pick<Storage, "setItem">): void {
  if (!scope) return;
  try { (storage ?? sessionStorage).setItem(`streamshop:${menu}:return`, JSON.stringify({ scope, page: position.page, cursors: position.cursors.map(cursor => cursor ?? null) })); } catch {}
}
export function takeCursorPosition(menu: CursorMenu, scope: string, storage?: Pick<Storage, "getItem" | "removeItem">): CursorPosition | null {
  try {
    const store = storage ?? sessionStorage, key = `streamshop:${menu}:return`;
    const raw = store.getItem(key);
    store.removeItem(key);
    const saved = JSON.parse(raw ?? "null");
    if (!scope || saved?.scope !== scope || !Number.isInteger(saved.page) || saved.page < 1 || !Array.isArray(saved.cursors) || saved.cursors.length !== saved.page || saved.cursors[0] !== null || !saved.cursors.slice(1).every((cursor: unknown) => typeof cursor === "string" && cursor.length > 0)) return null;
    return { page: saved.page, cursors: saved.cursors.map((cursor: string | null) => cursor ?? undefined) };
  } catch { return null; }
}
