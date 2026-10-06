"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { SmartBackButton } from "../../../../../../components/seller/SmartBackButton";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { NOTICE_CATEGORY, type NoticeItem } from "../../../../../../components/seller/platformNotice";
import { formatDateTime } from "../../../../../../lib/client/format";

// SA-112 공지 상세(정본 v302). 본문·올린 때, 「이 공지에 대해 문의」(SA-114로 공지 id를 넘김), 이전 공지·관련 공지. 열면 읽음으로 남긴다.
// API: GET /api/seller/platform-notices/{id} → { notice: { …, prev(더 최근), next(더 오래된), related } }, POST …/{id}/read.
// 정본의 「이전」은 목록에서 아래(더 오래된) 공지이므로 서버의 next를 쓴다.
type Brief = Pick<NoticeItem, "id" | "title" | "category" | "publishedAt">;
type Notice = NoticeItem & { body: string; prev: Brief | null; next: Brief | null; related: Brief[] };

export default function NoticeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; notice: Notice }>({ kind: "loading" });

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<{ notice: Notice }>(`/api/seller/platform-notices/${id}`);
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setState({ kind: "ok", notice: r.data.notice });
    // 열었으니 읽음으로 남긴다(마스터 대리 조회 등 쓸 수 없는 경우는 조용히 넘어간다)
    if (!r.data.notice.read) void api(`/api/seller/platform-notices/${id}/read`, { method: "POST" });
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <Topbar crumb="공지 · 문의 › 공지사항 › 상세" />
      <main className="main">
        <PageHead
          back="/seller/notices"
          title="공지 상세"
          actions={
            <Link className="btn btn-out" href="/seller/notices">
              목록
            </Link>
          }
        />
        {state.kind === "loading" && (
          <div className="card" style={{ padding: 24 }}>
            <LoadingRows rows={4} />
          </div>
        )}
        {state.kind === "error" && (
          <div className="card" style={{ padding: 24 }}>
            {state.status === 404 ? (
              <div className="st" style={{ boxShadow: "none" }}>
                <span className="t">공지를 찾을 수 없습니다</span>
                <span className="s">삭제되었거나 볼 수 없는 공지입니다.</span>
                <SmartBackButton fallback="/seller/notices" className="btn btn-sm btn-out">공지 목록</SmartBackButton>
              </div>
            ) : (
              <ErrorState title="공지를 불러오지 못했습니다" onRetry={() => void load()} />
            )}
          </div>
        )}
        {state.kind === "ok" && (
          <>
            <div className="card" style={{ padding: 24 }}>
              <article className="col" style={{ gap: 16 }}>
                <div className="col" style={{ gap: 8 }}>
                  <span className="row" style={{ gap: 6 }}>
                    <span className={`bdg ${NOTICE_CATEGORY[state.notice.category].cls}`}>{NOTICE_CATEGORY[state.notice.category].label}</span>
                    {state.notice.isPinned && <span className="bdg b-gray nodot">맨 위 고정</span>}
                  </span>
                  <h2 className="t-h2" data-testid="notice-title">
                    {state.notice.title}
                  </h2>
                  <span className="t-l2 c-alt num">ONQ 운영팀 · {formatDateTime(state.notice.publishedAt)} 올림</span>
                </div>
                <div className="t-b1" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }} data-testid="notice-body">
                  {state.notice.body}
                </div>
              </article>
            </div>
            <div className="au-lh">
              <span className="t-l2 c-alt">
                {state.notice.next && (
                  <Link href={`/seller/notices/${state.notice.next.id}`} data-testid="notice-older">
                    ‹ 이전: {state.notice.next.title}
                  </Link>
                )}
              </span>
              <div className="au-lh-act">
                <Link className="btn btn-sm btn-out" href={`/seller/inquiries/new?noticeId=${state.notice.id}`}>
                  이 공지에 대해 문의
                </Link>
              </div>
            </div>
            {state.notice.related.length > 0 && (
              <section className="au-fs">
                <div className="au-fs-h">
                  <h2 className="au-fs-t">관련 공지</h2>
                </div>
                <div className="au-lt-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>공지</th>
                      </tr>
                    </thead>
                    <tbody>
                      {state.notice.related.map((n) => (
                        <tr key={n.id}>
                          <td className="col-text">
                            <Link href={`/seller/notices/${n.id}`}>{n.title}</Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}
          </>
        )}
      </main>
    </>
  );
}
