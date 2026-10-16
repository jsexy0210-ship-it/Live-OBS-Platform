import { PublicFrame } from "./PublicFrame";
import { SELLER_TERMS } from "./sellerTerms";

// PF-008 이용약관(파트너스 약관 정본 docs/terms/SELLER_TERMS_TEMPLATE.md). 약관 원문은 문어체 「~합니다」를 그대로 쓴다.
// {{ }} 값이 하나라도 비어 있으면 「시행 전 초안」으로 표시하고, 빈 값은 「정해지는 대로 알려 드려요」로 보인다.
const fill = (s: string) => s.replace(/`/g, "").replace(/\{\{[^}]*\}\}/g, "정해지는 대로 알려 드려요");
const isDraft = SELLER_TERMS.some((s) => [s.heading, ...s.lines].some((l) => l.includes("{{")));
const tocLabel = (h: string) => fill(h).replace(/^제\d+조\(/, "").replace(/\)$/, "");
const fullText = SELLER_TERMS.map((s) => [fill(s.heading), ...s.lines.map(fill)].join("\n")).join("\n\n");
const isSub = (l: string) => /^\d+\.\s/.test(l);

type Block = { kind: "p"; text: string } | { kind: "ol"; items: string[] };
const blocks = (lines: string[]): Block[] =>
  lines.reduce<Block[]>((acc, l) => {
    const last = acc[acc.length - 1];
    if (isSub(l)) {
      const text = fill(l.replace(/^\d+\.\s/, ""));
      if (last?.kind === "ol") last.items.push(text);
      else acc.push({ kind: "ol", items: [text] });
    } else acc.push({ kind: "p", text: fill(l) });
    return acc;
  }, []);

export function Terms() {
  return (
    <PublicFrame>
      <section className="pf-sec pf-doc pf-document-section">
        <nav className="pf-toc" aria-label="목차">
          {SELLER_TERMS.map((s, i) => (
            <a key={s.heading} href={`#s${i}`}>
              {tocLabel(s.heading)}
            </a>
          ))}
        </nav>
        <article className="pf-doc-body">
          <h1 className="t-t1">이용약관</h1>
          <div className="pf-doc-meta">
            <span className="t-l2 c-alt num">
              제4판 · 시행일 정해지는 대로 알려 드려요{isDraft ? " · 시행 전 초안" : ""}
            </span>
            <a
              className="btn btn-sm btn-out"
              href={`data:text/plain;charset=utf-8,${encodeURIComponent(fullText)}`}
              download="이용약관.txt"
            >
              내려받기
            </a>
          </div>
          {isDraft && (
            <div className="msg msg-info t-l2" role="note" data-testid="terms-draft">
              시행 전 초안이에요. 아직 정해지지 않은 항목은 「정해지는 대로 알려 드려요」로 적어 두었어요.
            </div>
          )}
          {SELLER_TERMS.map((s, i) => (
            <section key={s.heading} id={`s${i}`} className="pf-art">
              <h2 className="t-hl1">{fill(s.heading)}</h2>
              {blocks(s.lines).map((b, j) =>
                b.kind === "p" ? (
                  <p key={j} className="t-b2 c-neu">
                    {b.text}
                  </p>
                ) : (
                  <ol key={j} className="t-b2 c-neu">
                    {b.items.map((it) => (
                      <li key={it}>{it}</li>
                    ))}
                  </ol>
                )
              )}
            </section>
          ))}
        </article>
      </section>
    </PublicFrame>
  );
}
