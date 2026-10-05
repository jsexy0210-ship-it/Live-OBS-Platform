// 로그인 뒤 갈 곳(next) 검사. 그 영역의 앱 안 경로만 받고, 쿼리는 유지한다(docs/IA.md 「Back · 상태 보존 규칙」 6항).
// 외부 주소·`//`·`\`·`..`·제어문자는 버린다. 순수 함수라 서버·클라이언트 어디서나 쓴다.

export const NEXT_SCOPE = {
  seller: ["/seller"],
  admin: ["/admin"],
  shop: (slug: string) => [`/shop/${slug}`],
} as const;

export function sanitizeNext(raw: unknown, scopes: readonly string[]): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2000) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(decoded)) return null;
  let url: URL;
  try {
    url = new URL(raw, "http://local.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://local.invalid") return null;
  const path = url.pathname;
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (decodedPath.split("/").some((s) => s === "..")) return null;
  const inScope = scopes.some((s) => path === s || path.startsWith(`${s}/`));
  if (!inScope) return null;
  return path + url.search;
}
