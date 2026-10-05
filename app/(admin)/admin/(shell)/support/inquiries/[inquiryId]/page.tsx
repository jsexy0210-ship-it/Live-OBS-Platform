"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { adminCan } from "../../../../../../../lib/server/authz/permissions";
import { textLength } from "../../../../../../../lib/server/text/clean";
import { Modal, PageHead } from "../../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../../components/seller/States";
import { adminApi, failMessage } from "../../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../../_components/AdminShell";
import { INQUIRY_CATEGORY, INQUIRY_STATUS, REPLY_MAX, type InquiryDetail } from "../../../../_components/inquiries";
import { dayTime } from "../../../../_components/partners";
import { useSmartBack } from "../../../../../../../lib/client/navigation";

// MA-052 문의 상세·답변(GET /api/admin/platform-inquiries/{id}, 답변·종료는 최고관리자·CS = support.manage, 나머지 역할은 보기만).
// 답변하면 「답변 완료」, 종료하면 파트너스는 더 쓸 수 없다. 그 사이 추가 문의가 달리면(409 version_conflict) 최신 대화를 다시 읽고 쓰던 답변은 남긴다.
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; inquiry: InquiryDetail };

function CloseModal({ inquiry, onClose, onDone, onStale }: { inquiry: InquiryDetail; onClose: () => void; onDone: (i: InquiryDetail) => void; onStale: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await adminApi<{ inquiry: InquiryDetail }>(`/api/admin/platform-inquiries/${inquiry.id}/close`, { method: "POST", json: { expectedVersion: inquiry.version } });
    setBusy(false);
    if (r.ok) return onDone(r.data.inquiry);
    if (r.status === 409 || r.status === 404) return onStale();
    setError(r.message ?? failMessage(r, "종료하지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };
  return (
    <Modal labelId="inquiry-close-title" busy={busy} onClose={onClose}>
      {(requestClose) => (
        <>
          <div className="modal-h">
            <h2 className="modal-t" id="inquiry-close-title">
              문의를 종료하시겠습니까?
            </h2>
            <span className="t-l2 c-alt">종료하면 {inquiry.shopName}은 이 문의에 더 쓸 수 없습니다.</span>
          </div>
          {error && (
            <div style={{ padding: "0 24px" }}>
              <span className="err" role="alert">
                {error}
              </span>
            </div>
          )}
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={requestClose} disabled={busy}>
              취소
            </button>
            <button className="btn" type="button" onClick={() => void submit()} disabled={busy}>
              {busy ? "처리 중" : "종료"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

export default function InquiryDetailPage() {
  const back = useSmartBack("/admin/support/inquiries");
  const { inquiryId } = useParams<{ inquiryId: string }>();
  const { me } = useAdmin();
  const canReply = adminCan(me.role, "support.manage");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const load = useCallback(async () => {
    const r = await adminApi<{ inquiry: InquiryDetail }>(`/api/admin/platform-inquiries/${encodeURIComponent(inquiryId)}`);
    setState(r.ok ? { kind: "ok", inquiry: r.data.inquiry } : { kind: "error", status: r.status });
  }, [inquiryId]);
  useEffect(() => void load(), [load]);

  const stale = () => {
    setClosing(false);
    setToast({ text: "그 사이 문의가 바뀌었습니다. 최신 대화를 불러옵니다.", neg: true });
    void load();
  };
  const count = textLength(body);
  const invalid = count === 0 || count > REPLY_MAX;
  const reply = async (inquiry: InquiryDetail) => {
    if (sending || invalid) return;
    setSending(true);
    setError(null);
    const r = await adminApi<{ inquiry: InquiryDetail }>(`/api/admin/platform-inquiries/${inquiry.id}/reply`, { method: "POST", json: { body: body.trim(), expectedVersion: inquiry.version } });
    setSending(false);
    if (r.ok) {
      setBody("");
      setState({ kind: "ok", inquiry: r.data.inquiry });
      return setToast({ text: "답변을 보냈습니다." });
    }
    if (r.status === 409 || r.status === 404) return stale();
    setError(r.message ?? failMessage(r, "답변을 보내지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };

  const inq = state.kind === "ok" ? state.inquiry : null;
  return (
    <>
      <AdminTopbar crumb="고객지원 › 파트너스 문의 › 문의 상세" />
      <main className="main">
        <PageHead
          title={inq ? inq.title : "문의 상세"}
          actions={
            <button className="btn btn-out" type="button" onClick={back}>목록</button>
          }
        />
        {!inq ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={4} />}
            {state.kind === "error" &&
              (state.status === 404 ? (
                <div className="st">
                  <span className="t">문의를 찾을 수 없습니다.</span>
                </div>
              ) : (
                <ErrorState title="문의를 불러오지 못했습니다." onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <div className="col" style={{ gap: 20 }}>
            <div className="card pad row" style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }} data-testid="inquiry-status">
              <span className={`bdg ${INQUIRY_STATUS[inq.status].cls}`}>{INQUIRY_STATUS[inq.status].label}</span>
              <span>{INQUIRY_CATEGORY[inq.category]}</span>
              <span className="c-alt">·</span>
              <Link href={`/admin/support/inquiries?sellerId=${inq.sellerId}`}>{inq.shopName}</Link>
              <span className="c-alt">· {inq.authorName ?? "-"} · {dayTime(inq.createdAt)}</span>
              {inq.notice && (
                <span className="t-l2 c-alt">
                  · 관련 공지 <Link href={`/admin/support/notices/${inq.notice.id}`}>{inq.notice.title}</Link>
                </span>
              )}
              {inq.status === "CLOSED" && <span className="t-l2 c-alt">· {dayTime(inq.closedAt)}에 {inq.closedByAdminName ?? "관리자"}가 종료했습니다.</span>}
            </div>
            <section className="card pad-l col" style={{ gap: 16 }} aria-label="대화">
              {inq.messages.map((m) => (
                <div key={m.id} className="col" style={{ gap: 6 }} data-testid="inquiry-message" data-author={m.author}>
                  <div className="row" style={{ gap: 8 }}>
                    <b>{m.author === "PLATFORM" ? `운영팀${m.authorName ? ` · ${m.authorName}` : ""}` : `파트너스${m.authorName ? ` · ${m.authorName}` : ""}`}</b>
                    <span className="t-l2 c-alt">{dayTime(m.createdAt)}</span>
                  </div>
                  <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{m.body}</p>
                  {m.images.length > 0 && (
                    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                      {m.images.map((i) => (
                        <a key={i.id} href={i.url} target="_blank" rel="noopener noreferrer">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={i.url} alt="첨부 사진" width={96} height={96} style={{ objectFit: "cover", borderRadius: 6 }} />
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </section>
            {inq.status !== "CLOSED" &&
              (canReply ? (
                <section className="card pad-l col" style={{ gap: 10 }} aria-labelledby="inquiry-reply">
                  <h2 className="t-hl1" id="inquiry-reply">
                    답변
                  </h2>
                  <textarea className="inp" rows={5} aria-label="답변 내용" value={body} onChange={(e) => setBody(e.target.value)} disabled={sending} />
                  <span className={`t-c1 ${count > REPLY_MAX ? "c-neg" : "c-alt"}`}>
                    {count}/{REPLY_MAX}
                  </span>
                  {error && (
                    <span className="err" role="alert">
                      {error}
                    </span>
                  )}
                  <div className="row" style={{ gap: 8 }}>
                    <button className="btn" type="button" onClick={() => void reply(inq)} disabled={sending || invalid}>
                      {sending ? "보내는 중" : "답변 보내기"}
                    </button>
                    <button className="btn btn-out" type="button" onClick={() => setClosing(true)} disabled={sending}>
                      문의 종료
                    </button>
                  </div>
                </section>
              ) : (
                <div className="card pad t-l2 c-alt" role="note">
                  답변과 종료는 최고관리자와 CS만 할 수 있습니다.
                </div>
              ))}
          </div>
        )}
      </main>
      {closing && inq && (
        <CloseModal
          inquiry={inq}
          onClose={() => setClosing(false)}
          onDone={(next) => {
            setClosing(false);
            setState({ kind: "ok", inquiry: next });
            setToast({ text: "문의를 종료했습니다." });
          }}
          onStale={stale}
        />
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
