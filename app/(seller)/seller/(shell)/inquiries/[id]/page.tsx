"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { InquiryAttach, type Attached } from "../../../../../../components/seller/InquiryAttach";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { SmartBackButton } from "../../../../../../components/seller/SmartBackButton";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { INQUIRY_BODY_MAX, INQUIRY_CATEGORY, INQUIRY_STATUS, type InquiryCategory, type InquiryStatus } from "../../../../../../components/seller/platformInquiry";
import { kstText } from "../../banners/_shared/ui";

// SA-115 문의 상세·답변 확인(파트너스 관리자). 보낸 내용과 플랫폼 답변을 대화로 보고, 추가 문의를 보낸다(상태가 답변 대기로 돌아감). 종료된 문의는 입력란을 숨기고 새 문의로 안내한다.
// 열면 읽음으로 처리된다. 플랫폼 답변은 관리자 이름 없이 「플랫폼」으로 보인다.
// API: GET /api/seller/platform-inquiries/{id} → { inquiry }, POST …/{id}/messages { body, imageIds? } → 201 { inquiry } · 409 inquiry_closed.
type Message = { id: string; author: "PARTNER" | "PLATFORM"; authorName: string | null; body: string; createdAt: string; images: { id: string; url: string }[] };
type Inquiry = { id: string; category: InquiryCategory; title: string; status: InquiryStatus; createdAt: string; lastMessageAt: string; closedAt: string | null; authorName: string | null; notice: { id: string; title: string } | null; messages: Message[] };

export default function InquiryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; inquiry: Inquiry }>({ kind: "loading" });
  const [body, setBody] = useState("");
  const [images, setImages] = useState<Attached[]>([]);
  const { confirm } = useConfirm();

  const load = useCallback(async () => {
    const r = await api<{ inquiry: Inquiry }>(`/api/seller/platform-inquiries/${id}`);
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setState({ kind: "ok", inquiry: r.data.inquiry });
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const send = async () => {
    if (!body.trim()) return;
    const ok = await confirm({
      title: "추가 문의를 보내시겠습니까?",
      body: "보낸 뒤에는 수정할 수 없고 문의가 다시 「답변 대기」가 됩니다.",
      confirmLabel: "추가 문의 보내기",
      run: async () => {
        const r = await api<{ inquiry: Inquiry }>(`/api/seller/platform-inquiries/${id}/messages`, { method: "POST", body: { body: body.trim(), imageIds: images.map((i) => i.id) } });
        if (r.ok) return;
        if (r.error === "inquiry_closed") void load();
        return r.message ?? "추가 문의를 보내지 못했습니다. 쓴 내용은 그대로 남아 있으니 다시 눌러 주십시오";
      },
    });
    if (!ok) return;
    setBody("");
    setImages([]);
    await load();
  };

  const inq = state.kind === "ok" ? state.inquiry : null;

  return (
    <>
      <Topbar crumb="공지 · 문의" />
      <main className="main">
        <PageHead
          back="/seller/inquiries"
          title="문의 내용"
        />
        <div className="card" style={{ padding: 24 }}>
          {state.kind === "loading" && <LoadingRows rows={4} />}
          {state.kind === "error" &&
            (state.status === 404 ? (
              <div className="st" style={{ boxShadow: "none" }}>
                <span className="t">문의를 찾을 수 없습니다</span>
                <span className="s">삭제되었거나 볼 수 없는 문의입니다.</span>
                <SmartBackButton fallback="/seller/inquiries" className="btn btn-sm btn-out">내 문의로</SmartBackButton>
              </div>
            ) : (
              <ErrorState title="문의를 불러오지 못했습니다" onRetry={() => void load()} />
            ))}
          {inq && (
            <div className="col" style={{ gap: 20 }}>
              <div className="col" style={{ gap: 8 }}>
                <span>
                  <span className={`bdg ${INQUIRY_STATUS[inq.status].cls}`}>{INQUIRY_STATUS[inq.status].label}</span> <span className="t-l2 c-alt">{INQUIRY_CATEGORY[inq.category]}</span>
                </span>
                <h2 className="t-h2" data-testid="inquiry-title">
                  {inq.title}
                </h2>
                <span className="t-l2 c-alt num">
                  {inq.authorName ? `${inq.authorName} · ` : ""}
                  {kstText(inq.createdAt)}
                  {inq.closedAt ? ` · 종료 ${kstText(inq.closedAt)}` : ""}
                </span>
                {inq.notice && (
                  <span className="t-l2">
                    관련 공지:{" "}
                    <Link href={`/seller/notices/${inq.notice.id}`} className="fw6">
                      {inq.notice.title}
                    </Link>
                  </span>
                )}
              </div>
              <div className="col" style={{ gap: 12 }} role="list" aria-label="대화">
                {inq.messages.map((m) => (
                  <div key={m.id} role="listitem" data-testid="inquiry-message" className="col" style={{ gap: 6, padding: 16, borderRadius: 12, background: m.author === "PLATFORM" ? "var(--wds-fill-alternative)" : "transparent", border: "1px solid var(--wds-line-normal-alternative)" }}>
                    <span className="t-l2">
                      <b>{m.author === "PLATFORM" ? "플랫폼" : (m.authorName ?? "파트너스")}</b> <span className="c-alt num">{kstText(m.createdAt)}</span>
                    </span>
                    <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.body}</span>
                    {m.images.length > 0 && (
                      <span className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                        {m.images.map((im) => (
                          <a key={im.id} href={im.url} target="_blank" rel="noopener noreferrer">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={im.url} alt="첨부 사진" style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 8 }} />
                          </a>
                        ))}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              {inq.status === "CLOSED" ? (
                <div className="msg msg-info" role="status">
                  <span>종료된 문의입니다. 이어서 문의하시려면 새 문의로 보내 주십시오.</span>
                  <Link className="btn btn-sm" href="/seller/inquiries/new">
                    문의하기
                  </Link>
                </div>
              ) : (
                <form
                  className="col"
                  style={{ gap: 12 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    void send();
                  }}
                >
                  <div className="fld">
                    <label htmlFor="iq-more" className="req">
                      추가 문의
                    </label>
                    <textarea id="iq-more" className="inp" style={{ height: 120, padding: "10px 12px" }} maxLength={INQUIRY_BODY_MAX} value={body} onChange={(e) => setBody(e.target.value)} />
                    <span className="help num">
                      {body.length}/{INQUIRY_BODY_MAX}자
                    </span>
                  </div>
                  <InquiryAttach images={images} onChange={setImages} />
                  <div className="row">
                    <button className="btn" type="submit" disabled={!body.trim()}>
                      추가 문의 보내기
                    </button>
                  </div>
                </form>
              )}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
