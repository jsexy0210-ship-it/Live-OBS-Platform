import Link from "next/link";
import "../../styles/tokens.css";
import "../../styles/lop.css";
import "../../styles/public.css";
import styles from "./NotFoundView.module.css";

// AU-009 공통 404. 공개 화면은 해요체, 관리자 화면(마스터·파트너스)은 합니다체.
const COPY = {
  public: { title: "페이지를 찾을 수 없어요", body: "주소가 바뀌었거나 지워졌어요. 주소를 다시 확인하거나 홈으로 가 주세요.", cta: "홈으로" },
  admin: { title: "페이지를 찾을 수 없습니다", body: "주소를 다시 확인해 주십시오. 이동했거나 삭제된 페이지일 수 있습니다.", cta: "대시보드로" },
} as const;

export function NotFoundView({ tone, href, standalone }: { tone: keyof typeof COPY; href: string; standalone?: boolean }) {
  const c = COPY[tone];
  return (
    <div className={`${standalone ? "app " : ""}pf ${styles.page}`} data-theme={standalone ? "light" : undefined}>
      <main className={styles.main} data-testid="not-found">
        <div className={styles.auth}>
          <div className={styles.heading}>
            <h1 className="t-h2">{c.title}</h1>
            <p className="t-b1">{c.body}</p>
          </div>
          <Link className="btn btn-lg btn-block" href={href}>
            {c.cta}
          </Link>
          {tone === "public" && (
            <div className={styles.links}>
              <Link className="t-c1 c-alt" href="/faq">
                자주 묻는 질문
              </Link>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
