import sanitizeHtml from "sanitize-html";

// 상세 설명 에디터 HTML 정화(2026-10-06 대표님 지시, 무료 오픈소스 sanitize-html). 저장 때 서버가 허용한 태그·속성만 남기고 나머지는 지운다.
// - 태그: 문단·제목(h1~h4)·글자 꾸밈(strong·b·em·i·u·s)·인용·목록·구분선·링크(a)·사진(img)·표(table 계열). 스크립트·스타일·iframe·폼·SVG 같은 건 내용까지 지운다.
// - 속성: 정해 둔 것만. 인라인 스타일은 text-align(left·right·center·justify)과 글자색 color·배경색 background-color만(값은 #hex 3·6자리, rgb()·rgba() 숫자만, url()·expression·var()·색 이름 등은 지운다). 링크는 http·https·mailto·tel만(나머지는 글자만 남김), 새 창·rel(noopener noreferrer nofollow)은 서버가 붙인다.
// - 사진: src는 이 상품의 상세 사진(우리 업로드 경로)만. 외부 주소·다른 상품·없는 사진이면 지운다. 저장 형태는 버전 없는 /api/seller/products/{상품}/images/{사진}이고, 읽을 때 쓰는 쪽(파트너스 관리자·구매자)에 맞는 주소로 바꾼다.
// - 지운 곳 수(removedCount)를 돌려줘 화면이 「허용하지 않는 코드 N곳을 지우고 저장했습니다」를 보여 준다.
export const DETAIL_HTML_MAX_TEXT = 20000;
export const DETAIL_HTML_MAX_CHARS = 400_000;

const ALLOWED_TAGS = [
  "p", "br", "hr", "h1", "h2", "h3", "h4", "strong", "b", "em", "i", "u", "s", "blockquote", "ul", "ol", "li", "a", "img",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col", "span",
];
const ALIGNABLE = ["p", "h1", "h2", "h3", "h4", "li", "th", "td"];
// 글자색·배경색은 에디터가 span(또는 문단·표 칸)에 붙인다. 스타일이 없는 span은 태그만 벗긴다.
const STYLABLE = [...ALIGNABLE, "span"];
const ATTRS: Record<string, string[]> = {
  a: ["href", "target", "rel"],
  img: ["src", "alt", "width", "height"],
  td: ["colspan", "rowspan", "style"],
  th: ["colspan", "rowspan", "style", "scope"],
  col: ["span"],
  colgroup: ["span"],
  ...Object.fromEntries(STYLABLE.filter((t) => t !== "td" && t !== "th").map((t) => [t, ["style"]])),
};
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SELLER_SRC = new RegExp(`^/api/seller/products/(${UUID})/images/(${UUID})(?:\\?v=[0-9a-f]{1,64})?$`, "i");
const SHOP_SRC = new RegExp(`^/api/shop/[^/?#]+/products/(${UUID})/images/(${UUID})(?:\\?v=[0-9a-f]{1,64})?$`, "i");
const LINK = /^(?:https?:\/\/|mailto:|tel:)/i;
const ALIGN_DECL = /^text-align\s*:\s*(left|right|center|justify)$/i;
const COLOR_DECL = /^(color|background-color)\s*:\s*(.+)$/i;
const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const RGB_COLOR = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d{1,3}|1\.0{1,3})\s*)?\)$/i;
// 색 값: #hex(3·6자리) 또는 rgb()·rgba() 숫자만(채널 0~255, 투명도 0~1). 나머지(url()·expression()·var()·색 이름·변수)는 null.
function cleanColor(raw: string): string | null {
  const v = raw.trim();
  if (HEX_COLOR.test(v)) return v.toLowerCase();
  const m = RGB_COLOR.exec(v);
  if (!m) return null;
  const ch = [m[1], m[2], m[3]].map(Number);
  if (ch.some((n) => n > 255)) return null;
  const rgb = ch.join(",");
  return m[4] === undefined ? `rgb(${rgb})` : `rgba(${rgb},${Number(m[4])})`;
}
const SMALL_INT = /^[1-9]\d?$/;
const SIZE = /^\d{1,4}$/;

export const canonicalImageSrc = (productId: string, imageId: string) => `/api/seller/products/${productId}/images/${imageId}`;

export type DetailHtmlContext = { productId: string; imageIds: ReadonlySet<string> };
export type DetailHtmlResult = { ok: true; html: string; removedCount: number; textLength: number } | { ok: false; reason: "invalid_detail" | "detail_too_long" };

export function sanitizeDetailHtml(input: unknown, ctx: DetailHtmlContext): DetailHtmlResult {
  if (typeof input !== "string") return { ok: false, reason: "invalid_detail" };
  if (input.length > DETAIL_HTML_MAX_CHARS) return { ok: false, reason: "detail_too_long" };
  let removed = 0;
  const productId = ctx.productId.toLowerCase();
  const html = sanitizeHtml(input, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ATTRS,
    allowedSchemes: ["http", "https", "mailto", "tel"],
    allowedStyles: { "*": { "text-align": [/^(left|right|center|justify)$/i], color: [HEX_COLOR, /^rgba?\([0-9., ]+\)$/i], "background-color": [HEX_COLOR, /^rgba?\([0-9., ]+\)$/i] } },
    allowProtocolRelative: false,
    disallowedTagsMode: "discard",
    transformTags: {
      "*": (tagName, attribs) => {
        const name = tagName.toLowerCase();
        if (!ALLOWED_TAGS.includes(name)) {
          removed++;
          return { tagName, attribs: {} };
        }
        const allowed = new Set(ATTRS[name] ?? []);
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(attribs)) {
          if (!allowed.has(k)) {
            // 링크의 새 창·rel은 서버가 붙이니 지웠다고 세지 않는다
            removed++;
            continue;
          }
          next[k] = v;
        }
        if (next.style !== undefined) {
          const kept: string[] = [];
          for (const decl of next.style.split(";").map((d) => d.trim()).filter(Boolean)) {
            const m = ALIGN_DECL.exec(decl);
            if (m) {
              kept.push(`text-align:${m[1].toLowerCase()}`);
              continue;
            }
            const c = COLOR_DECL.exec(decl);
            const color = c ? cleanColor(c[2]) : null;
            if (c && color) kept.push(`${c[1].toLowerCase()}:${color}`);
            else removed++;
          }
          if (kept.length) next.style = kept.join(";");
          else delete next.style;
        }
        // 스타일이 남지 않은 span은 글자만 남긴다(span이 허용 목록에 있어, 쓰지 않는 이름으로 바꿔 태그만 벗긴다)
        if (name === "span" && next.style === undefined) {
          removed++;
          return { tagName: "x-strip", attribs: {} };
        }
        for (const k of ["colspan", "rowspan", "span"]) {
          if (next[k] !== undefined && !SMALL_INT.test(next[k])) {
            removed++;
            delete next[k];
          }
        }
        if (name === "th" && next.scope !== undefined && !/^(row|col|rowgroup|colgroup)$/.test(next.scope)) {
          removed++;
          delete next.scope;
        }
        if (name === "a") {
          const href = (next.href ?? "").trim();
          if (!LINK.test(href)) {
            if (next.href !== undefined) removed++;
            // 쓸 수 없는 링크는 글자만 남긴다(x-strip은 허용 목록에 없어 태그만 벗겨진다)
            return { tagName: "x-strip", attribs: {} };
          }
          return { tagName: "a", attribs: { href, target: "_blank", rel: "noopener noreferrer nofollow" } };
        }
        if (name === "img") {
          const src = (next.src ?? "").trim();
          const m = SELLER_SRC.exec(src) ?? SHOP_SRC.exec(src);
          if (!m || m[1].toLowerCase() !== productId || !ctx.imageIds.has(m[2].toLowerCase())) {
            removed++;
            return { tagName: "img", attribs: {} };
          }
          const out: Record<string, string> = { src: canonicalImageSrc(productId, m[2].toLowerCase()) };
          if (next.alt !== undefined) out.alt = next.alt.slice(0, 200);
          for (const k of ["width", "height"]) {
            if (next[k] === undefined) continue;
            if (SIZE.test(next[k])) out[k] = next[k];
            else removed++;
          }
          return { tagName: "img", attribs: out };
        }
        return { tagName: name, attribs: next };
      },
    },
    // 사진 주소가 맞지 않아 src를 잃은 img는 통째로 지운다
    exclusiveFilter: (frame) => frame.tag === "img" && !frame.attribs.src,
  });

  // 글자 수 한도에는 공백도 넣고, 내용이 있는지는 공백을 뺀 글자로 본다
  let textLength = 0;
  let visibleLength = 0;
  sanitizeHtml(html, {
    allowedTags: [],
    allowedAttributes: {},
    textFilter: (t) => {
      textLength += t.length;
      visibleLength += t.trim().length;
      return t;
    },
  });
  if (textLength > DETAIL_HTML_MAX_TEXT) return { ok: false, reason: "detail_too_long" };
  const hasContent = visibleLength > 0 || /<(img|table|hr)\b/i.test(html);
  return { ok: true, html: hasContent ? html : "", removedCount: removed, textLength };
}

// 저장된 HTML의 사진 주소를 읽는 쪽에 맞는 주소로 바꾼다(없는 사진이면 그 사진을 뺀다).
export function renderDetailHtml(html: string, productId: string, urlOf: (imageId: string) => string | null): string {
  const re = new RegExp(`<img\\b[^>]*?src="/api/seller/products/${productId}/images/(${UUID})"[^>]*?/?>`, "gi");
  return html.replace(re, (tag, imageId: string) => {
    const url = urlOf(imageId.toLowerCase());
    return url === null ? "" : tag.replace(/src="[^"]*"/, `src="${url.replace(/&/g, "&amp;")}"`);
  });
}

// 지운 상세 사진을 HTML에서 뺀다.
export function dropImageFromHtml(html: string, productId: string, imageId: string): string {
  return renderDetailHtml(html, productId, (id) => (id === imageId.toLowerCase() ? null : canonicalImageSrc(productId, id)));
}
