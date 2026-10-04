// 배너·팝업 링크 검사. 받는 값은 둘뿐이다.
// - 쇼핑몰 안 경로: /로 시작(예: /products/abc). 화면에서 쇼핑몰 주소(/shop/{slug}) 뒤에 붙인다.
//   //·/\로 시작해 다른 사이트로 가는 값, 경로 밖으로 나가는 값은 URL 해석 결과로 거부한다.
// - http(s) 주소: 아이디·비밀번호가 든 주소는 거부한다.
// javascript:·data:·mailto: 등 그 밖의 형식, 줄바꿈·제어 문자가 든 값은 모두 거부한다.
export const LINK_MAX = 500;

const BASE = "https://shop.invalid";
const CONTROL = /[\u0000-\u001f\u007f\s]/;

export type LinkCheck = { ok: true; value: string | null } | { ok: false };

// null·빈 문자열 → 링크 없음. 정리한 값(경로는 pathname+search+hash, 주소는 href)을 돌려준다.
export function normalizeLink(v: unknown): LinkCheck {
  if (v === null || v === undefined || v === "") return { ok: true, value: null };
  if (typeof v !== "string") return { ok: false };
  const t = v.trim();
  if (t === "") return { ok: true, value: null };
  if (t.length > LINK_MAX || CONTROL.test(t)) return { ok: false };
  if (t.startsWith("/")) {
    if (t.startsWith("//") || t.startsWith("/\\")) return { ok: false };
    let u: URL;
    try {
      u = new URL(t, BASE);
    } catch {
      return { ok: false };
    }
    if (u.origin !== BASE) return { ok: false };
    const value = `${u.pathname}${u.search}${u.hash}`;
    return value.length <= LINK_MAX ? { ok: true, value } : { ok: false };
  }
  if (!/^https?:\/\//i.test(t)) return { ok: false };
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return { ok: false };
  }
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || !u.hostname) return { ok: false };
  return u.href.length <= LINK_MAX ? { ok: true, value: u.href } : { ok: false };
}

// 구매자 화면에서 쓸 주소. 쇼핑몰 안 경로는 쇼핑몰 주소 뒤에 붙이고, 바깥 주소는 새 창으로 연다.
export function resolveLink(slug: string, link: string | null): { href: string; external: boolean } | null {
  if (!link) return null;
  if (link.startsWith("/")) return { href: `/shop/${encodeURIComponent(slug)}${link === "/" ? "" : link}`, external: false };
  return { href: link, external: true };
}
