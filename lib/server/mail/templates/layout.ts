// 메일 공통 틀(디자인 EM-001~004·101·102 v321 FINAL): 폭 600px · 해요체 · 버튼 높이 44 이상 · 날짜는 「2026.10.02 20:41」(KST).
// 메일 프로그램은 grid·flex·color-mix·CSS 변수를 못 쓰므로 표(table)와 인라인 스타일로 만들고, 쇼핑몰 색의 연한 바탕·테두리는 미리 섞어 계산한다.
// 내용은 「블록」 목록 하나로 적고 HTML과 텍스트를 같이 만든다(두 쪽이 어긋나지 않게). 값은 모두 여기서 이스케이프한다.
export type Brand = {
  name: string; // 헤더에 보이는 이름(쇼핑몰 이름 또는 「ONQ 파트너스」)
  mark: string; // 로고 칸 글자(이미지는 메일에서 막히는 일이 많아 글자로)
  color: string; // #rrggbb
  site: string; // 헤더 오른쪽 주소 표기
};
export type FooterInfo = { title: string; lines: string[] };

export type Block =
  | { t: "h1"; text: string }
  | { t: "p"; text: string; muted?: boolean }
  | { t: "box"; accent?: boolean; title?: string; rows?: [string, string][]; lines?: string[]; muted?: string }
  | { t: "items"; lines: { name: string; qty?: number; amount: number }[]; extra?: { label: string; value: string }[]; total: { label: string; value: string } }
  | { t: "buttons"; buttons: { label: string; url: string; secondary?: boolean }[] };

export type MailBody = { subject: string; text: string; html: string };

const DEFAULT_COLOR = "#5b3df6";
export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
export const won = (n: number) => `${Math.round(n).toLocaleString("en-US")}원`;
export const signedWon = (n: number) => (n < 0 ? `−${won(-n)}` : won(n));

const KST_MS = 9 * 3600_000;
const kst = (d: Date) => new Date(d.getTime() + KST_MS);
const p2 = (n: number) => String(n).padStart(2, "0");
const DAYS = ["일", "월", "화", "수", "목", "금", "토"];
// 2026.10.02 20:41
export const dateTime = (d: Date) => {
  const k = kst(d);
  return `${k.getUTCFullYear()}.${p2(k.getUTCMonth() + 1)}.${p2(k.getUTCDate())} ${p2(k.getUTCHours())}:${p2(k.getUTCMinutes())}`;
};
// 2026.10.05 (월)
export const dateDay = (d: Date) => {
  const k = kst(d);
  return `${k.getUTCFullYear()}.${p2(k.getUTCMonth() + 1)}.${p2(k.getUTCDate())} (${DAYS[k.getUTCDay()]})`;
};
// 2026.10.09
export const dateOnly = (d: Date) => {
  const k = kst(d);
  return `${k.getUTCFullYear()}.${p2(k.getUTCMonth() + 1)}.${p2(k.getUTCDate())}`;
};
// 10월 3일 (토) 오후 8시 41분
export const deadline = (d: Date) => {
  const k = kst(d);
  const h = k.getUTCHours();
  return `${k.getUTCMonth() + 1}월 ${k.getUTCDate()}일 (${DAYS[k.getUTCDay()]}) ${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}시 ${p2(k.getUTCMinutes())}분`;
};

export const safeColor = (c: unknown) => (typeof c === "string" && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : DEFAULT_COLOR);
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mix = (hex: string, ratio: number) => `#${rgb(hex).map((c) => Math.round(255 - (255 - c) * ratio).toString(16).padStart(2, "0")).join("")}`;
// 글자색: 바탕이 밝으면 어두운 글자, 어두우면 흰 글자
const ink = (hex: string) => {
  const [r, g, b] = rgb(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#1b1b1f" : "#ffffff";
};
// 링크는 http·https만(그 밖의 주소는 #으로 막는다)
export const safeUrl = (u: string) => (/^https?:\/\/[^\s"<>]+$/i.test(u) ? u : "#");

const FONT = "-apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif";

function renderBlock(b: Block, color: string): { html: string; text: string } {
  const accBg = mix(color, 0.1);
  const accBorder = mix(color, 0.35);
  switch (b.t) {
    case "h1":
      return { html: `<tr><td style="padding:0 28px 18px;font-size:22px;line-height:1.35;font-weight:800;letter-spacing:-0.3px;color:#1b1b1f">${esc(b.text)}</td></tr>`, text: b.text };
    case "p":
      return { html: `<tr><td style="padding:0 28px 18px;font-size:${b.muted ? 13 : 14}px;line-height:1.6;color:${b.muted ? "#6b6b76" : "#1b1b1f"}">${esc(b.text)}</td></tr>`, text: b.text };
    case "box": {
      const rows = (b.rows ?? [])
        .map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;width:96px;vertical-align:top;font-size:13px;color:#6b6b76">${esc(k)}</td><td style="padding:2px 0;font-size:13px;font-weight:600;color:#1b1b1f">${esc(v)}</td></tr>`)
        .join("");
      const lines = (b.lines ?? []).map((l) => `<div style="font-size:13px;line-height:1.6;color:#1b1b1f">${esc(l)}</div>`).join("");
      const inner =
        (b.title ? `<div style="font-size:13px;font-weight:700;color:#1b1b1f;padding-bottom:4px">${esc(b.title)}</div>` : "") +
        (rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}</table>` : "") +
        lines +
        (b.muted ? `<div style="font-size:12.5px;line-height:1.6;color:#6b6b76;padding-top:6px">${esc(b.muted)}</div>` : "");
      const style = b.accent ? `background:${accBg};border:1px solid ${accBorder}` : "background:#f6f5fa";
      const text = [b.title, ...(b.rows ?? []).map(([k, v]) => `${k}: ${v}`), ...(b.lines ?? []), b.muted].filter(Boolean).join("\n");
      return { html: `<tr><td style="padding:0 28px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td style="${style};border-radius:12px;padding:14px 16px">${inner}</td></tr></table></td></tr>`, text };
    }
    case "items": {
      const line = (name: string, right: string, sub?: string) =>
        `<tr><td style="padding:10px 0;border-bottom:1px solid #ecebf2;font-size:13px;vertical-align:top;color:#1b1b1f">${esc(name)}${sub ? `<div style="color:#6b6b76">${esc(sub)}</div>` : ""}</td><td align="right" style="padding:10px 0;border-bottom:1px solid #ecebf2;font-size:13px;white-space:nowrap;vertical-align:top;color:#1b1b1f">${esc(right)}</td></tr>`;
      const rows = b.lines.map((l) => line(l.name, won(l.amount), l.qty ? `수량 ${l.qty}` : undefined)).join("") + (b.extra ?? []).map((e) => line(e.label, e.value)).join("");
      const tot = `<tr><td style="padding:12px 0 0;font-size:15px;font-weight:800;color:#1b1b1f">${esc(b.total.label)}</td><td align="right" style="padding:12px 0 0;font-size:15px;font-weight:800;white-space:nowrap;color:#1b1b1f">${esc(b.total.value)}</td></tr>`;
      const text = [...b.lines.map((l) => `${l.name}${l.qty ? ` x ${l.qty}` : ""}  ${won(l.amount)}`), ...(b.extra ?? []).map((e) => `${e.label}  ${e.value}`), `${b.total.label}  ${b.total.value}`].join("\n");
      return { html: `<tr><td style="padding:0 28px 18px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}${tot}</table></td></tr>`, text };
    }
    case "buttons": {
      const html = b.buttons
        .map((btn, i) => {
          const url = safeUrl(btn.url);
          const style = btn.secondary
            ? `background:#ffffff;color:${color};border:1.5px solid ${color}`
            : `background:${color};color:${ink(color)};border:1.5px solid ${color}`;
          return `<div style="padding-top:${i === 0 ? 0 : 8}px"><a href="${esc(url)}" style="display:block;text-align:center;${style};font-weight:700;font-size:15px;line-height:24px;padding:14px 20px;border-radius:12px;text-decoration:none;min-height:44px;box-sizing:border-box">${esc(btn.label)}</a></div>`;
        })
        .join("");
      return { html: `<tr><td style="padding:4px 28px 18px">${html}</td></tr>`, text: b.buttons.map((btn) => `${btn.label}: ${safeUrl(btn.url)}`).join("\n") };
    }
  }
}

export function renderMail(o: { subject: string; brand: Brand; blocks: Block[]; footer: FooterInfo }): MailBody {
  const color = safeColor(o.brand.color);
  const parts = o.blocks.map((b) => renderBlock(b, color));
  const header = `<tr><td style="background:${color};color:${ink(color)};padding:18px 28px"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td width="46" style="vertical-align:middle"><div style="width:36px;height:36px;line-height:36px;text-align:center;border-radius:10px;background:${ink(color) === "#ffffff" ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.12)"};font-size:11px;font-weight:700">${esc(o.brand.mark)}</div></td><td style="vertical-align:middle;font-size:16px;font-weight:700;color:${ink(color)}">${esc(o.brand.name)}</td><td align="right" style="vertical-align:middle;font-size:12px;color:${ink(color)};opacity:0.85">${esc(o.brand.site)}</td></tr></table></td></tr>`;
  const footer = `<tr><td style="padding:18px 28px 24px;background:#f6f5fa;color:#6b6b76;font-size:11.5px;line-height:1.7"><div style="font-weight:700;color:#1b1b1f">${esc(o.footer.title)}</div>${o.footer.lines.map((l) => `<div>${esc(l)}</div>`).join("")}</td></tr>`;
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.subject)}</title></head><body style="margin:0;padding:24px 0;background:#eeedf3;font-family:${FONT}"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center"><table role="presentation" class="em" width="600" cellpadding="0" cellspacing="0" style="width:600px;max-width:100%;background:#ffffff;border-radius:14px;overflow:hidden;font-size:14px;line-height:1.6;color:#1b1b1f">${header}<tr><td style="height:28px;line-height:28px;font-size:0">&nbsp;</td></tr>${parts.map((p) => p.html).join("")}<tr><td style="height:2px;line-height:2px;font-size:0">&nbsp;</td></tr>${footer}</table></td></tr></table></body></html>`;
  const text = [`[${o.brand.name}]`, ...parts.map((p) => p.text), "", o.footer.title, ...o.footer.lines].join("\n\n").replace(/\n{3,}/g, "\n\n");
  return { subject: o.subject, text, html };
}
