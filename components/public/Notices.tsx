import Link from "next/link";
import { PublicFrame } from "./PublicFrame";
import { noticeDate, noticeDetailHref, noticeListHref, PUBLIC_NOTICE_CATEGORY, type NoticeListState, type PublicNoticeCategory } from "./noticeView";

// PF-005 공지 목록(디자인 PF-005). 고정 공지는 첫 쪽 맨 위, 나머지는 게시일 최신순.
export type NoticeRow = { id: string; title: string; category: PublicNoticeCategory; isPinned: boolean; publishedAt: Date | string };

// 정본 PF-005 분류 칩(「안내」는 전체에서만 보인다)
const CHIPS: [string, string | null][] = [
  ["전체", null],
  ["점검", "MAINTENANCE"],
  ["새 기능", "FEATURE"],
  ["정책", "POLICY"],
];

function Row({ n, state }: { n: NoticeRow; state: NoticeListState }) {
  const c = PUBLIC_NOTICE_CATEGORY[n.category];
  return (
    <li>
      <Link className="pf-notice-row" href={noticeDetailHref(n.id, state)}>
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

export function Notices({
  pinned,
  items,
  nextCursor,
  failed,
  category = null,
  page,
  pageSize,
  total,
  pageCount,
  cursor,
}: {
  pinned: NoticeRow[];
  items: NoticeRow[];
  nextCursor: string | null;
  failed?: boolean;
  category?: string | null;
  page?: number;
  pageSize?: number;
  total?: number;
  pageCount?: number;
  cursor?: string | null;
}) {
  const state: NoticeListState = { category, page, pageSize, cursor };
  const filterCategory = ["MAINTENANCE", "FEATURE", "POLICY", "GENERAL"].includes(category ?? "") ? category : null;
  const activePage = page && pageCount ? Math.min(page, pageCount) : page ?? 1;
  const pageStart = pageCount && pageCount > 5 ? Math.max(1, Math.min(activePage - 2, pageCount - 4)) : 1;
  const pageEnd = pageCount ? Math.min(pageCount, pageStart + 4) : 0;
  const pages = Array.from({ length: pageEnd - pageStart + 1 }, (_, i) => pageStart + i);
  const pageHref = (n: number) => noticeListHref({ category: filterCategory, page: n, pageSize });
  return (
    <PublicFrame active="/notices">
      <section className="pf-sec">
        <h1 className="t-d2">공지</h1>
        <div className="pf-chips" role="group" aria-label="분류">
          {CHIPS.map(([label, v]) => (
            <Link key={label} className={`chip${(filterCategory ?? null) === v ? " on" : ""}`} href={v ? `/notices?category=${v}` : "/notices"} aria-current={(filterCategory ?? null) === v ? "true" : undefined}>
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
                <Row key={n.id} n={n} state={state} />
              ))}
              {items.map((n) => (
                <Row key={n.id} n={n} state={state} />
              ))}
            </ul>
            {pageCount !== undefined && pageCount > 0 && (
              <nav className="pg" aria-label="공지 페이지 이동" data-testid="notice-pagination">
                {activePage > 1 && <Link href={pageHref(activePage - 1)} aria-label="이전 페이지">이전</Link>}
                {pages.map((n) => (
                  <Link key={n} className={n === activePage ? "on" : ""} href={pageHref(n)} aria-current={n === activePage ? "page" : undefined} data-testid={`notice-page-${n}`}>
                    {n}
                  </Link>
                ))}
                {activePage < pageCount && <Link href={pageHref(activePage + 1)} aria-label="다음 페이지">다음</Link>}
              </nav>
            )}
            {nextCursor && (
              <Link className="btn btn-out" href={noticeListHref({ category, cursor: nextCursor })}>
                다음 공지 보기
              </Link>
            )}
          </>
        )}
      </section>
    </PublicFrame>
  );
}
