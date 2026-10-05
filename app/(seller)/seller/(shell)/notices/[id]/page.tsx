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
import { kstText } from "../../banners/_shared/ui";

// SA-112 공지 상세. 본문·게시일·발송 채널, 「관련 문의하기」(SA-114로 공지 id를 넘김). API: GET /api/seller/platform-notices/{id} → { notice }.
type Notice = NoticeItem & { body: string; channels: string[] };
const CHANNEL: Record<string, string> = { IN_APP: "화면 공지" };

export default function NoticeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; notice: Notice }>({ kind: "loading" });

  const load = useCallback(async () => {
    const r = await api<{ notice: Notice }>(`/api/seller/platform-notices/${id}`);
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setState({ kind: "ok", notice: r.data.notice });
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <Topbar crumb="공지 · 문의" />
      <main className="main">
        <PageHead
          back="/seller/notices"
          title="공지사항"
        />
        <div className="card" style={{ padding: 24 }}>
          {state.kind === "loading" && <LoadingRows rows={4} />}
          {state.kind === "error" &&
            (state.status === 404 ? (
              <div className="st" style={{ boxShadow: "none" }}>
                <span className="t">공지를 찾을 수 없습니다</span>
                <span className="s">삭제되었거나 볼 수 없는 공지입니다.</span>
                <SmartBackButton fallback="/seller/notices" className="btn btn-sm btn-out">공지 목록으로</SmartBackButton>
              </div>
            ) : (
              <ErrorState title="공지를 불러오지 못했습니다" onRetry={() => void load()} />
            ))}
          {state.kind === "ok" && (
            <article className="col" style={{ gap: 16 }}>
              <div className="col" style={{ gap: 8 }}>
                <span>
                  <span className={`bdg ${NOTICE_CATEGORY[state.notice.category].cls}`}>{NOTICE_CATEGORY[state.notice.category].label}</span>
                  {state.notice.isPinned && <span className="bdg b-info nodot"> 고정</span>}
                </span>
                <h2 className="t-h2" data-testid="notice-title">
                  {state.notice.title}
                </h2>
                <span className="t-l2 c-alt num">
                  올린 날 {kstText(state.notice.publishedAt)} · 보인 곳: {state.notice.channels.map((c) => CHANNEL[c] ?? "기타").join(" · ")}
                </span>
              </div>
              <div className="t-b1" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }} data-testid="notice-body">
                {state.notice.body}
              </div>
              <div className="row" style={{ gap: 8 }}>
                <Link className="btn btn-out" href={`/seller/inquiries/new?noticeId=${state.notice.id}`}>
                  이 공지로 문의하기
                </Link>
              </div>
            </article>
          )}
        </div>
      </main>
    </>
  );
}
