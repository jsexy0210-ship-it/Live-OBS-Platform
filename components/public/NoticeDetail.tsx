import Link from "next/link";
import { PublicFrame } from "./PublicFrame";
import { noticeDate, PUBLIC_NOTICE_CATEGORY, type PublicNoticeCategory } from "./noticeView";

// PF-006 공지 상세. 본문은 글자 그대로(줄바꿈만 살려) 보여 준다.
export function NoticeDetail({ notice }: { notice: { title: string; body: string; category: PublicNoticeCategory; publishedAt: Date | string } }) {
  const c = PUBLIC_NOTICE_CATEGORY[notice.category];
  return (
    <PublicFrame active="/notices">
      <section className="pf-sec pf-doc">
        <article className="pf-doc-body">
          <span className={`bdg ${c.cls}`}>{c.label}</span>
          <h1 className="t-t1">{notice.title}</h1>
          <span className="t-c1 c-alt">{noticeDate(notice.publishedAt)}</span>
          <p className="t-b1 pf-notice-body" data-testid="notice-body">
            {notice.body}
          </p>
          <Link className="btn btn-out" href="/notices">
            목록으로
          </Link>
        </article>
      </section>
    </PublicFrame>
  );
}
