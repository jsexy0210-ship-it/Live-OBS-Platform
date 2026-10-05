// 앱 안 이동 기록(순수 로직). 화면 ← 버튼이 「앱 안 이전 화면이 있는가」를 판단하는 근거다.
// 알 수 없으면 항상 부모 fallback 쪽으로 기운다(엉뚱한 곳으로 돌아가지 않는 것이 우선).

export type NavStack = readonly string[];

const MAX = 50;
const AUTH_PATH = /\/(login|logout|signup|register|forgot-password|reset-password)(\/|$)/;

/** 영역 구분: 구매자는 `/shop/{slug}`, 그 밖에는 첫 경로 조각 */
export function scopeOf(path: string): string {
  const p = path.split(/[?#]/)[0];
  const seg = p.split("/").filter(Boolean);
  if (seg[0] === "shop" && seg[1]) return `/shop/${seg[1]}`;
  return seg[0] ? `/${seg[0]}` : "/";
}

export function onNavigate(stack: NavStack, path: string, kind: "push" | "replace" | "pop"): NavStack {
  if (kind === "pop") {
    if (stack.length >= 2 && stack[stack.length - 2] === path) return stack.slice(0, -1);
    return [path]; // 앞으로 가기 등 알 수 없는 이동: 기록을 버리고 새로 시작
  }
  if (stack.length === 0) return [path];
  if (kind === "replace") return [...stack.slice(0, -1), path];
  if (stack[stack.length - 1] === path) return stack;
  return [...stack, path].slice(-MAX);
}

export function previousOf(stack: NavStack): string | null {
  return stack.length >= 2 ? stack[stack.length - 2] : null;
}

/** 이전 화면으로 돌아가도 되는가: 인증 화면이 아니고, fallback과 같은 영역(같은 파트너스·마스터·쇼핑몰)일 때만 */
export function canGoBackTo(prev: string | null, fallback: string): boolean {
  if (!prev) return false;
  if (AUTH_PATH.test(prev.split(/[?#]/)[0])) return false;
  return scopeOf(prev) === scopeOf(fallback);
}
