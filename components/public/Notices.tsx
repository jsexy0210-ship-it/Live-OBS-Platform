import Link from "next/link";
import { PublicFrame } from "./PublicFrame";
import { noticeDate, PUBLIC_NOTICE_CATEGORY, type PublicNoticeCategory } from "./noticeView";

// PF-005 공지 목록(디자인 PF-005). 고정 공지는 첫 쪽 맨 위, 나머지는 게시일 최신순.
export type NoticeRow = { id: string; title: string; category: PublicNoticeCategory; isPinned: boolean; publishedAt: Date | string };

function Row({ n }: { n: NoticeRow }) {
  const c = PUBLIC_NOTICE_CATEGORY[n.category];
  return (
    <li>
      <Link className="pf-notice-row" href={`/notices/${n.id}`}>
        <span className={`bdg ${c.cls}`}>{c.label}</span>
        <span className="t-l1 pf-notice-title">
          {n.isPinned && <span className="c-alt">고정 · </span>}
          {n.title}
        </span>
        <span className="t-c1 c-alt">{noticeDate(n.publishedAt)}</span>
      </Link>
    </li>
  );
}

export function Notices({ pinned, items, nextCursor, failed }: { pinned: NoticeRow[]; items: NoticeRow[]; nextCursor: string | null; failed?: boolean }) {
  return (
    <PublicFrame active="/notices">
      <section className="pf-sec">
        <h1 className="t-d2">공지</h1>
        {failed ? (
          <div className="card pf-ask" data-testid="notices-failed">
            <span className="t-hl2">공지를 불러오지 못했어요</span>
            <Link className="btn btn-out" href="/notices">
              다시 시도
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
              <Link className="btn btn-out" href={`/notices?cursor=${encodeURIComponent(nextCursor)}`}>
                다음 공지 보기
              </Link>
            )}
          </>
        )}
      </section>
    </PublicFrame>
  );
}
