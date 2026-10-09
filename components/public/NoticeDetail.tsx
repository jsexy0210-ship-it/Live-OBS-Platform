import Link from "next/link";
import { PublicFrame } from "./PublicFrame";
import { noticeDate, noticeDetailHref, PUBLIC_NOTICE_CATEGORY, type NoticeListState, type NoticeNeighbor, type PublicNoticeCategory } from "./noticeView";

// PF-006 공지 상세. 본문은 글자 그대로(줄바꿈만 살려) 보여 준다.
export function NoticeDetail({ notice, listHref, listState }: { notice: { title: string; body: string; category: PublicNoticeCategory; publishedAt: Date | string; author: string; prev: NoticeNeighbor; next: NoticeNeighbor }; listHref: string; listState: NoticeListState }) {
  const c = PUBLIC_NOTICE_CATEGORY[notice.category];
  return (
    <PublicFrame active="/notices">
      <section className="pf-sec pf-doc">
        <article className="pf-doc-body">
          <Link className="t-l2" href={listHref}>
            ← 공지 목록
          </Link>
          <div className="col" style={{ gap: 10 }}>
            <div className="row" style={{ gap: 8 }}>
              <span className={`bdg ${c.cls}`}>{c.label}</span>
              <span className="t-l2 c-alt num">{noticeDate(notice.publishedAt)} · {notice.author}</span>
            </div>
            <h1 className="t-t1">{notice.title}</h1>
          </div>
          <p className="t-b1 pf-notice-body" data-testid="notice-body">
            {notice.body}
          </p>
          <nav className="row between pf-notice-neighbors" aria-label="이전·다음 공지" data-testid="notice-neighbors" style={{ paddingTop: 24, boxShadow: "inset 0 1px 0 var(--wds-line-normal-alternative)" }}>
            {notice.next ? (
              <Link className="t-l2" href={noticeDetailHref(notice.next.id, listState)}>
                ← 이전: {notice.next.title}
              </Link>
            ) : (
              <span className="t-l2 c-alt">이전 공지가 없어요</span>
            )}
            {notice.prev ? (
              <Link className="t-l2" href={noticeDetailHref(notice.prev.id, listState)}>
                다음: {notice.prev.title} →
              </Link>
            ) : (
              <span className="t-l2 c-alt">다음 공지가 없어요</span>
            )}
          </nav>
        </article>
      </section>
    </PublicFrame>
  );
}
