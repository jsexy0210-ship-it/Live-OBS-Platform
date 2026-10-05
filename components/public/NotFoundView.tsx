import Link from "next/link";
import "../../styles/tokens.css";
import "../../styles/lop.css";
import "../../styles/public.css";

// AU-009 공통 404. 공개 화면은 해요체, 관리자 화면(마스터·파트너스)은 합니다체.
const COPY = {
  public: { title: "페이지를 찾을 수 없어요", body: "주소를 다시 확인해 주세요. 페이지가 옮겨졌거나 없어졌을 수 있어요.", cta: "처음으로" },
  admin: { title: "페이지를 찾을 수 없습니다", body: "주소를 다시 확인해 주십시오. 이동했거나 삭제된 페이지일 수 있습니다.", cta: "홈으로" },
} as const;

export function NotFoundView({ tone, href, standalone }: { tone: keyof typeof COPY; href: string; standalone?: boolean }) {
  const c = COPY[tone];
  return (
    <div className={`${standalone ? "app " : ""}pf pf-mt`} data-theme={standalone ? "light" : undefined}>
      <main className="pf-mt-box" data-testid="not-found">
        <h1 className="t-h2">{c.title}</h1>
        <p className="t-b1">{c.body}</p>
        <Link className="btn" href={href}>
          {c.cta}
        </Link>
      </main>
    </div>
  );
}
