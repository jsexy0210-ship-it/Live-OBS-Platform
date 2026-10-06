import Link from "next/link";
import { PublicFrame } from "./PublicFrame";
import { noticeDate, PUBLIC_NOTICE_CATEGORY, type PublicNoticeCategory } from "./noticeView";

// PF-005 공지 목록(디자인 PF-005). 고정 공지는 첫 쪽 맨 위, 나머지는 게시일 최신순.
export type NoticeRow = { id: string; title: string; category: PublicNoticeCategory; isPinned: boolean; publishedAt: Date | string };

// 정본 PF-005 분류 칩(「안내」는 전체에서만 보인다)
const CHIPS: [string, string | null][] = [
  ["전체", null],
  ["점검", "MAINTENANCE"],
  ["새 기능", "FEATURE"],
  ["정책", "POLICY"],
];

function Row({ n }: { n: NoticeRow }) {
  const c = PUBLIC_NOTICE_CATEGORY[n.category];
  return (
    <li>
      <Link className="pf-notice-row" href={`/notices/${n.id}`}>
        <span className="row pf-notice-l">
          <span className={`bdg ${c.cls}`}>{c.label}</span>
          {n.isPinned && <span className="bdg b-open nodot">고정</span>}
          <span className="t-l1 fw6 pf-notice-title">{n.title}</span>
        </span>
        <span className="t-l2 c-alt num pf-notice-date">{noticeDate(n.publishedAt)}</span>
      </Link>
    </li>
  );
}

export function Notices({ pinned, items, nextCursor, failed, category = null }: { pinned: NoticeRow[]; items: NoticeRow[]; nextCursor: string | null; failed?: boolean; category?: string | null }) {
  return (
    <PublicFrame active="/notices">
      <section className="pf-sec">
        <h1 className="t-d2">공지</h1>
        <div className="pf-chips" role="group" aria-label="분류">
          {CHIPS.map(([label, v]) => (
            <Link key={label} className={`chip${(category ?? null) === v ? " on" : ""}`} href={v ? `/notices?category=${v}` : "/notices"} aria-current={(category ?? null) === v ? "true" : undefined}>
              {label}
            </Link>
          ))}
        </div>
        {failed ? (
          <div className="card pf-ask" data-testid="notices-failed">
            <span className="t-hl2">공지를 불러오지 못했어요</span>
            <Link className="btn btn-out" href="/notices">
              다시 불러오기
            </Link>
          </div>
        ) : pinned.length + items.length === 0 ? (
          <p className="t-b1 c-alt" data-testid="notices-empty">
            아직 올라온 공지가 없어요.
          </p>
        ) : (
          <>
            <ul className="pf-notice-list" data-testid="notices-list">
              {pinned.map((n) => (
                <Row key={n.id} n={n} />
              ))}
              {items.map((n) => (
                <Row key={n.id} n={n} />
              ))}
            </ul>
            {nextCursor && (
              <Link className="btn btn-out" href={`/notices?${category ? `category=${category}&` : ""}cursor=${encodeURIComponent(nextCursor)}`}>
                다음 공지 보기
              </Link>
            )}
          </>
        )}
      </section>
    </PublicFrame>
  );
}
