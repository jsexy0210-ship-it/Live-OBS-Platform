"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { FormRow, PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { InquiryAttach, type Attached, type AttachedFile } from "../../../../../../components/seller/InquiryAttach";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { SmartBackButton } from "../../../../../../components/seller/SmartBackButton";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { api } from "../../../../../../components/seller/api";
import { INQUIRY_BODY_MAX, INQUIRY_CATEGORY, type InquiryCategory, type InquiryStatus } from "../../../../../../components/seller/platformInquiry";
import { formatDate, formatDateTime } from "../../../../../../lib/client/format";
import "../new/new.css";

// SA-115 문의 상세·답변 확인(파트너스 관리자, 정본 v310). 보낸 내용과 ONQ 운영팀 답변을 대화로 보고, 추가 문의를 보낸다(다시 「보냄」). 「해결됐습니다 · 종료」·「문의 종료」, 답변 평가, 관련 공지, 처리 이력.
// 열면 읽음으로 처리된다. 답변 작성자는 마스터 담당자 이름 없이 「ONQ 운영팀」, 담당이 정해지면 「담당자 배정됨」 칩만 붙는다. 종료된 문의는 입력란을 숨기고 새 문의로 안내한다.
// API: GET /api/seller/platform-inquiries/{id} → { inquiry }, POST …/{id}/messages { body, imageIds?, fileIds? } · POST …/{id}/close { helpful? } · POST …/{id}/rating { helpful }.
type Attachment = { id: string; name: string; byteSize: number; url: string };
type Message = { id: string; author: "PARTNER" | "PLATFORM"; authorName: string | null; body: string; createdAt: string; images: { id: string; url: string }[]; files: Attachment[] };
type History = { type: "RECEIVED" | "ANSWERED" | "FOLLOWUP" | "CLOSED"; at: string; actor: "PARTNER" | "PLATFORM" };
type Inquiry = {
  id: string;
  category: InquiryCategory;
  title: string;
  status: InquiryStatus;
  createdAt: string;
  closedAt: string | null;
  closedBy: "PARTNER" | "PLATFORM" | null;
  notice: { id: string; title: string } | null;
  related: { order: { orderNoLabel: string; nickname: string | null; createdAt: string } | null; broadcast: { title: string | null; startedAt: string } | null };
  helpful: boolean | null;
  canClose: boolean;
  canRate: boolean;
  handlerState: "ASSIGNED" | "PREPARING" | null;
  history: History[];
  messages: Message[];
};
// 상태 이름·색은 정본 SA-115(보냄 · 답변 완료 · 종료)
const STATUS: Record<InquiryStatus, { label: string; cls: string }> = {
  OPEN: { label: "보냄", cls: "b-info" },
  ANSWERED: { label: "답변 완료", cls: "b-pending" },
  CLOSED: { label: "종료", cls: "b-done" },
};
const HISTORY: Record<History["type"], (a: History["actor"]) => string> = {
  RECEIVED: () => "문의 보냄",
  ANSWERED: () => "답변 완료 · ONQ 운영팀",
  FOLLOWUP: () => "추가 문의 보냄",
  CLOSED: (a) => (a === "PARTNER" ? "문의 종료 · 파트너스" : "문의 종료 · ONQ 운영팀"),
};
const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1024))}KB`);

export default function InquiryDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { me } = useSeller();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; inquiry: Inquiry }>({ kind: "loading" });
  const [body, setBody] = useState("");
  const [images, setImages] = useState<Attached[]>([]);
  const [files, setFiles] = useState<AttachedFile[]>([]);
  const [rating, setRating] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
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
      body: "보낸 뒤에는 수정할 수 없고 문의가 다시 「보냄」이 됩니다.",
      confirmLabel: "추가 문의 보내기",
      run: async () => {
        const r = await api<{ inquiry: Inquiry }>(`/api/seller/platform-inquiries/${id}/messages`, { method: "POST", body: { body: body.trim(), imageIds: images.map((i) => i.id), fileIds: files.map((f) => f.id) } });
        if (r.ok) return;
        if (r.error === "inquiry_closed") void load();
        return r.message ?? "추가 문의를 보내지 못했습니다. 쓴 내용은 그대로 남아 있으니 다시 눌러 주십시오";
      },
    });
    if (!ok) return;
    setBody("");
    setImages([]);
    setFiles([]);
    await load();
  };

  // 종료(「해결됐습니다 · 종료」는 도움됨 평가를 함께 남긴다)
  const close = async (helpful?: boolean) => {
    const ok = await confirm({
      title: "문의를 종료하시겠습니까?",
      body: "종료하면 추가 문의를 보낼 수 없습니다. 이어서 문의하시려면 새 문의로 보내 주십시오.",
      confirmLabel: "문의 종료",
      danger: true,
      run: async () => {
        const r = await api<{ inquiry: Inquiry }>(`/api/seller/platform-inquiries/${id}/close`, { method: "POST", body: helpful === undefined ? {} : { helpful } });
        if (r.ok) return;
        if (r.error === "inquiry_closed") void load();
        return r.message ?? "문의를 종료하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오";
      },
    });
    if (!ok) return;
    setToast({ text: "문의를 종료했습니다" });
    await load();
  };

  const rate = async (helpful: boolean) => {
    if (rating) return;
    setRating(true);
    const r = await api<{ helpful: boolean }>(`/api/seller/platform-inquiries/${id}/rating`, { method: "POST", body: { helpful } });
    setRating(false);
    if (!r.ok) return setToast({ text: r.message ?? "평가를 남기지 못했습니다. 잠시 뒤에 다시 눌러 주십시오", neg: true });
    setToast({ text: "평가를 남겼습니다" });
    await load();
  };

  const inq = state.kind === "ok" ? state.inquiry : null;
  const relatedText = inq?.related.broadcast ? `${formatDate(inq.related.broadcast.startedAt)} 방송` : inq?.related.order ? `${formatDateTime(inq.related.order.createdAt)} 주문${inq.related.order.nickname ? ` · ${inq.related.order.nickname}` : ""}` : null;
  const assigned = inq?.handlerState === "ASSIGNED";

  return (
    <>
      <Topbar crumb="공지 · 문의 › 내 문의 › 상세" />
      <main className="main">
        <PageHead description="문의 내용과 답변을 확인하고 추가 내용을 남깁니다."
          back="/seller/inquiries"
          title="문의 상세"
          actions={
            inq && (
              <>
                <Link className="btn btn-out" href="/seller/inquiries">
                  목록
                </Link>
                {inq.canClose && (
                  <button className="btn btn-out" type="button" onClick={() => void close()}>
                    문의 종료
                  </button>
                )}
              </>
            )
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
                <span className="t">문의를 찾을 수 없습니다</span>
                <span className="s">삭제되었거나 볼 수 없는 문의입니다.</span>
                <SmartBackButton fallback="/seller/inquiries" className="btn btn-sm btn-out">내 문의로</SmartBackButton>
              </div>
            ) : (
              <ErrorState title="문의를 불러오지 못했습니다" onRetry={() => void load()} />
            )}
          </div>
        )}
        {inq && (
          <>
            <div className="card" style={{ padding: 20, marginBottom: 24 }}>
              <div className="col" style={{ gap: 8 }}>
                <span className="row" style={{ gap: 6 }}>
                  <span className={`bdg ${STATUS[inq.status].cls}`} data-testid="inquiry-status">{inq.status === "CLOSED" && inq.closedAt ? `종료 · ${formatDate(inq.closedAt)}` : STATUS[inq.status].label}</span>
                  {assigned && <span className="bdg b-gray nodot">담당자 배정됨</span>}
                </span>
                <h2 className="t-h2" data-testid="inquiry-title">
                  {inq.title}
                </h2>
                <span className="t-l2 c-alt num">
                  {INQUIRY_CATEGORY[inq.category]} · {formatDateTime(inq.createdAt)} 보냄{relatedText ? ` · 관련: ${relatedText}` : ""}
                </span>
                {inq.status === "OPEN" && <span className="t-l2 c-alt">ONQ 운영팀이 확인 중입니다</span>}
              </div>
            </div>
            <div className="iq-two">
              <div className="col" style={{ gap: 16 }}>
                <section className="au-fs">
                  <div className="au-fs-h">
                    <h2 className="au-fs-t">대화</h2>
                  </div>
                  <div className="col" style={{ gap: 12 }} role="list" aria-label="대화">
                    {inq.messages.map((m) => (
                      <div key={m.id} role="listitem" data-testid="inquiry-message" className="col" style={{ gap: 6, padding: 16, borderRadius: 12, background: m.author === "PLATFORM" ? "var(--wds-fill-alternative)" : "transparent", border: "1px solid var(--wds-line-normal-alternative)" }}>
                        <span className="t-l2">
                          <b>{m.author === "PLATFORM" ? "ONQ 운영팀" : (m.authorName ?? me.shop.name)}</b>
                          {m.author === "PLATFORM" && assigned && <span className="bdg b-gray nodot"> 담당자 배정됨</span>} <span className="c-alt num">· {formatDateTime(m.createdAt)}</span>
                        </span>
                        <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.body}</span>
                        {(m.images.length > 0 || m.files.length > 0) && (
                          <span className="row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                            {m.images.map((im) => (
                              <a key={im.id} href={im.url} target="_blank" rel="noopener noreferrer">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={im.url} alt="첨부 사진" style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 8 }} />
                              </a>
                            ))}
                            {m.files.map((f) => (
                              <a key={f.id} className="bdg b-gray nodot" href={f.url} download data-testid="message-file">
                                첨부 {f.name} · {sizeText(f.byteSize)}
                              </a>
                            ))}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </section>
                {inq.status === "CLOSED" ? (
                  <div className="msg msg-info" role="status">
                    <span>종료된 문의입니다. 이어서 문의하시려면 새 문의로 보내 주십시오.</span>
                    <Link className="btn btn-sm" href="/seller/inquiries/new">
                      새 문의
                    </Link>
                  </div>
                ) : (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      void send();
                    }}
                  >
                    <table className="au-ft">
                      <tbody>
                      <FormRow label="추가 문의 보내기" htmlFor="iq-more">
                        <div className="col" style={{ gap: 8, width: "100%" }}>
                          <textarea id="iq-more" placeholder="추가로 궁금한 내용을 적어 주십시오" className="inp" style={{ width: "100%", height: 120, padding: "10px 12px" }} maxLength={INQUIRY_BODY_MAX} value={body} onChange={(e) => setBody(e.target.value)} />
                          <span className="t-c1 c-alt num">
                            {[...body].length} / {INQUIRY_BODY_MAX.toLocaleString("ko-KR")}
                          </span>
                          <InquiryAttach images={images} onChange={setImages} files={files} onFilesChange={setFiles} />
                        </div>
                      </FormRow>
                      <FormRow label="">
                        <button className="btn" type="submit" disabled={!body.trim()}>
                          추가 문의 보내기
                        </button>
                        {inq.canClose && (
                          <button className="btn btn-out" type="button" onClick={() => void close(true)}>
                            해결됐습니다 · 종료
                          </button>
                        )}
                      </FormRow>
                      </tbody>
                    </table>
                  </form>
                )}
              </div>
              <div className="col" style={{ gap: 16 }}>
                {(inq.canRate || inq.helpful !== null) && (
                  <section className="au-fs">
                    <div className="au-fs-h">
                      <h2 className="au-fs-t">답변이 도움이 됐습니까?</h2>
                    </div>
                    {inq.helpful === null ? (
                      <div className="row" style={{ gap: 8 }}>
                        <button className="btn btn-sm" type="button" disabled={rating} onClick={() => void rate(true)}>
                          도움됨
                        </button>
                        <button className="btn btn-sm btn-out" type="button" disabled={rating} onClick={() => void rate(false)}>
                          아니요
                        </button>
                      </div>
                    ) : (
                      <span className="t-l2" data-testid="inquiry-helpful">
                        {inq.helpful ? "도움됨으로 남겼습니다" : "도움이 되지 않았다고 남겼습니다"}
                      </span>
                    )}
                  </section>
                )}
                {inq.notice && (
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
                          <tr>
                            <td className="col-text">
                              <Link href={`/seller/notices/${inq.notice.id}`}>{inq.notice.title}</Link>
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
                <section className="au-fs">
                  <div className="au-fs-h">
                    <h2 className="au-fs-t">처리 이력</h2>
                  </div>
                  <div className="au-lt-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th style={{ width: 150 }}>시각</th>
                          <th>내용</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inq.history.map((h, i) => (
                          <tr key={i} data-testid="inquiry-history">
                            <td className="num">{formatDateTime(h.at)}</td>
                            <td className="col-text">{HISTORY[h.type](h.actor)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              </div>
            </div>
          </>
        )}
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
