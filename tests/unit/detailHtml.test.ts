import { describe, expect, it } from "vitest";
import { DETAIL_HTML_MAX_CHARS, DETAIL_HTML_MAX_TEXT, canonicalImageSrc, dropImageFromHtml, renderDetailHtml, sanitizeDetailHtml } from "../../lib/server/products/detailHtml";

// 상세 설명 에디터 HTML 정화(허용 태그·속성만 남기기, XSS 사례)
const PID = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const IMG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GONE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ctx = { productId: PID, imageIds: new Set([IMG]) };
const clean = (html: unknown) => {
  const r = sanitizeDetailHtml(html, ctx);
  if (!r.ok) throw new Error(r.reason);
  return r;
};

describe("허용한 것은 그대로", () => {
  it("글자 꾸미기·문단·제목·목록·인용·구분선·표를 남긴다", () => {
    const html = '<h2>제목</h2><p style="text-align:center">문단 <strong>굵게</strong> <em>기울임</em> <u>밑줄</u> <s>취소</s></p><ul><li>하나</li></ul><ol><li>둘</li></ol><blockquote>인용</blockquote><hr /><table><thead><tr><th scope="col">구분</th></tr></thead><tbody><tr><td colspan="2" rowspan="1">값</td></tr></tbody></table>';
    const r = clean(html);
    expect(r.removedCount).toBe(0);
    expect(r.html).toContain('<p style="text-align:center">');
    for (const part of ["<h2>제목</h2>", "<strong>굵게</strong>", "<em>기울임</em>", "<u>밑줄</u>", "<s>취소</s>", "<li>하나</li>", "<blockquote>인용</blockquote>", "<hr />", '<th scope="col">구분</th>', '<td colspan="2" rowspan="1">값</td>']) {
      expect(r.html).toContain(part);
    }
  });
  it("이 상품의 상세 사진은 버전·쇼핑몰 주소 형태로 와도 버전 없는 저장 주소로 바꿔 남기고 크기·설명도 지킨다", () => {
    for (const src of [`/api/seller/products/${PID}/images/${IMG}?v=abc123def456`, `/api/shop/my-shop/products/${PID}/images/${IMG}?v=abc123def456`, `/api/seller/products/${PID}/images/${IMG}`]) {
      const r = clean(`<p><img src="${src}" alt="상품 사진" width="860" height="600"></p>`);
      expect(r.removedCount).toBe(0);
      expect(r.html).toBe(`<p><img src="${canonicalImageSrc(PID, IMG)}" alt="상품 사진" width="860" height="600" /></p>`);
    }
  });
  it("링크는 http·https·mailto·tel만, 새 창·rel은 서버가 붙이고 사용자가 보낸 값은 덮는다", () => {
    const r = clean('<a href="https://example.com/a?b=1&c=2" target="_self" rel="opener">링크</a> <a href="mailto:a@b.co">메일</a> <a href="tel:0212345678">전화</a>');
    expect(r.html).toContain('<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">링크</a>');
    expect(r.html).toContain('href="mailto:a@b.co"');
    expect(r.html).toContain('href="tel:0212345678"');
    expect(r.html).not.toContain("opener\"");
  });
});

describe("위험한 것은 지운다", () => {
  const bad: [string, string][] = [
    ["script", '<p>안녕</p><script>alert(1)</script>'],
    ["대소문자 섞은 script", "<ScRiPt>alert(1)</sCrIpT><p>안녕</p>"],
    ["쪼개 쓴 script", "<scr<script>ipt>alert(1)</scr</script>ipt><p>안녕</p>"],
    ["이벤트 속성", '<p onclick="alert(1)" onmouseover="alert(2)">안녕</p>'],
    ["img onerror", '<p>안녕</p><img src="x" onerror="alert(1)">'],
    ["javascript 링크", '<p>안녕</p><a href="javascript:alert(1)">클릭</a>'],
    ["탭이 섞인 javascript 링크", '<p>안녕</p><a href="jav&#x09;ascript:alert(1)">클릭</a>'],
    ["공백 앞선 javascript 링크", '<p>안녕</p><a href="  javascript:alert(1)">클릭</a>'],
    ["data 링크", '<p>안녕</p><a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">클릭</a>'],
    ["vbscript 링크", '<p>안녕</p><a href="vbscript:msgbox(1)">클릭</a>'],
    ["iframe", '<p>안녕</p><iframe src="https://evil.example"></iframe>'],
    ["object·embed", '<p>안녕</p><object data="x"></object><embed src="x">'],
    ["form·input", '<p>안녕</p><form action="https://evil.example"><input name="pw"></form>'],
    ["svg", '<p>안녕</p><svg onload="alert(1)"><circle/></svg>'],
    ["math", '<p>안녕</p><math><mi xlink:href="javascript:alert(1)">x</mi></math>'],
    ["style 태그", "<p>안녕</p><style>body{display:none}</style>"],
    ["meta·link·base", '<p>안녕</p><meta http-equiv="refresh" content="0;url=https://evil.example"><link rel="stylesheet" href="https://evil.example/x.css"><base href="https://evil.example/">'],
    ["위험한 스타일", '<p style="position:fixed;top:0;background:url(javascript:alert(1))">안녕</p>'],
    ["외부 이미지", '<p>안녕</p><img src="https://evil.example/pixel.png">'],
    ["data 이미지", '<p>안녕</p><img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">'],
    ["다른 상품 이미지", `<p>안녕</p><img src="/api/seller/products/${OTHER}/images/${IMG}">`],
    ["올리지 않은 이미지", `<p>안녕</p><img src="/api/seller/products/${PID}/images/${GONE}">`],
    ["상대 경로 이미지", '<p>안녕</p><img src="../../secret.png">'],
    ["프로토콜 상대 이미지", '<p>안녕</p><img src="//evil.example/x.png">'],
  ];
  for (const [name, html] of bad) {
    it(`${name}: 위험한 부분만 지우고 글은 남기며 지운 곳을 센다`, () => {
      const r = clean(html);
      expect(r.removedCount).toBeGreaterThanOrEqual(1);
      expect(r.html).toContain("안녕");
      for (const needle of ["<script", "onerror", "onclick", "onmouseover", "onload", "javascript:", "vbscript:", "data:", "<iframe", "<object", "<embed", "<form", "<input", "<svg", "<math", "<style", "<meta", "<link", "<base", "evil.example", "position:", "secret.png", "<img"]) {
        expect(r.html.toLowerCase(), `${name} → ${needle}`).not.toContain(needle);
      }
    });
  }
  it("script·style 안의 글자는 본문에 남기지 않는다", () => {
    const r = clean("<p>보임</p><script>document.cookie</script><style>.x{}</style>");
    expect(r.html).toBe("<p>보임</p>");
  });
  it("허용 밖 태그(div·span·font)는 태그만 벗기고 글은 남긴다", () => {
    const r = clean("<div><span>글</span> <font color=red>색</font></div>");
    expect(r.html).toBe("글 색");
    expect(r.removedCount).toBeGreaterThanOrEqual(3);
  });
  it("지운 곳 수는 지운 태그·속성마다 하나씩, 깨끗한 글은 0", () => {
    expect(clean('<p onclick="x" class="y" id="z">글</p>').removedCount).toBe(3);
    expect(clean('<p>글</p><script>1</script><iframe></iframe>').removedCount).toBe(2);
    expect(clean("<p>그냥 글</p>").removedCount).toBe(0);
  });
  it("표 칸 병합 값이 이상하면 그 속성만 지운다", () => {
    const r = clean('<table><tr><td colspan="99999" rowspan="x">값</td></tr></table>');
    expect(r.html).toContain("<td>값</td>");
    expect(r.removedCount).toBe(2);
  });
});

describe("한도와 빈 값", () => {
  it("글자 20,000자는 되고 20,001자는 막으며, 태그 길이는 글자 수에 넣지 않는다", () => {
    expect(clean(`<p>${"가".repeat(DETAIL_HTML_MAX_TEXT)}</p>`).textLength).toBe(DETAIL_HTML_MAX_TEXT);
    expect(sanitizeDetailHtml(`<p>${"가".repeat(DETAIL_HTML_MAX_TEXT + 1)}</p>`, ctx)).toEqual({ ok: false, reason: "detail_too_long" });
    expect(clean(`<p><strong>${"가".repeat(DETAIL_HTML_MAX_TEXT)}</strong></p>`).textLength).toBe(DETAIL_HTML_MAX_TEXT);
  });
  it("너무 큰 원문은 읽지 않고 거절, 문자열이 아니면 invalid_detail", () => {
    expect(sanitizeDetailHtml("a".repeat(DETAIL_HTML_MAX_CHARS + 1), ctx)).toEqual({ ok: false, reason: "detail_too_long" });
    for (const v of [null, undefined, 1, {}, []]) expect(sanitizeDetailHtml(v, ctx)).toEqual({ ok: false, reason: "invalid_detail" });
  });
  it("내용이 없으면(빈 글·공백만·태그만) 빈 문자열, 사진·표·구분선만 있으면 내용으로 본다", () => {
    for (const v of ["", "   ", "<p></p>", "<p> </p><br>"]) expect(clean(v).html).toBe("");
    expect(clean(`<img src="${canonicalImageSrc(PID, IMG)}">`).html).toContain("<img");
    expect(clean("<hr>").html).toContain("<hr");
  });
});

describe("읽는 쪽 주소 바꾸기·사진 빼기", () => {
  const stored = `<p>앞</p><img src="${canonicalImageSrc(PID, IMG)}" alt="a &amp; b" /><p>뒤</p>`;
  it("저장 주소를 읽는 쪽 주소로 바꾼다(&는 이스케이프)", () => {
    const out = renderDetailHtml(stored, PID, (id) => `/api/shop/s/products/${PID}/images/${id}?v=abc&x=1`);
    expect(out).toContain(`src="/api/shop/s/products/${PID}/images/${IMG}?v=abc&amp;x=1"`);
    expect(out).toContain('alt="a &amp; b"');
  });
  it("없는 사진이면 그 사진만 뺀다", () => {
    expect(renderDetailHtml(stored, PID, () => null)).toBe("<p>앞</p><p>뒤</p>");
  });
  it("지운 사진만 HTML에서 빼고 다른 사진은 그대로", () => {
    const two = `${stored}<img src="${canonicalImageSrc(PID, GONE)}" />`;
    const out = dropImageFromHtml(two, PID, IMG);
    expect(out).not.toContain(IMG);
    expect(out).toContain(GONE);
    expect(dropImageFromHtml(stored, OTHER, IMG)).toBe(stored);
  });
});
