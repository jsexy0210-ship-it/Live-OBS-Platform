"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { adminCan } from "../../../../../../../lib/server/authz/permissions";
import { textLength } from "../../../../../../../lib/server/text/clean";
import { PageHead } from "../../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../../components/seller/States";
import { adminApi, failMessage } from "../../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../../_components/AdminShell";
import { SELLER_STATUS, day, dayTime, reasonLabel, text, type ReviewRow, type SellerDetail } from "../../../../_components/partners";
import { MAX_REASON } from "../../../../_components/SuspendDialog";

// MA-014 가입 신청 상세: 신청 내용(GET /api/admin/sellers/{id})과 확인 필요 항목(GET …/review)을 보고 승인·반려한다.
// 승인·반려는 최고관리자·운영만 보인다. 반려는 사유 필수(1~200자). 이미 처리됐으면(409) 최신 상태로 다시 읽는다.
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; seller: SellerDetail; reasons: string[] };

function Info({ title, id, rows }: { title: string; id: string; rows: [string, React.ReactNode][] }) {
  return (
    <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby={id}>
      <h2 className="t-hl1" id={id}>
        {title}
      </h2>
      <dl className="kv">
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: "contents" }}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function RejectDialog({ id, shopName, onClose, onDone, onStale }: { id: string; shopName: string; onClose: () => void; onDone: () => void; onStale: () => void }) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = textLength(reason);
  const invalid = count === 0 || count > MAX_REASON;
  const submit = async () => {
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    const r = await adminApi(`/api/admin/sellers/${id}/reject`, { method: "POST", json: { reason: reason.trim() } });
    setBusy(false);
    if (r.ok) return onDone();
    if (r.status === 404 || r.status === 409) return onStale();
    setError(r.error === "reason_required" ? "사유를 1자 이상 200자 이하로 입력해 주십시오." : failMessage(r, "처리하지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };
  return (
    <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="reject-title">
      <div className="modal">
        <div className="modal-h">
          <h2 className="t-h2" id="reject-title">
            가입을 반려하시겠습니까?
          </h2>
          <span className="t-l2 c-alt">{shopName}의 가입 신청이 반려되며, 같은 대표자가 다시 신청할 수 있습니다.</span>
        </div>
        <div className="col" style={{ gap: 6, padding: "0 24px" }}>
          <label className="lbl" htmlFor="reject-reason">
            반려 사유
          </label>
          <textarea id="reject-reason" className="inp" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
          <span className={`t-c1 ${count > MAX_REASON ? "c-neg" : "c-alt"}`}>
            {count}/{MAX_REASON}
          </span>
          {error && (
            <span className="err" role="alert">
              {error}
            </span>
          )}
        </div>
        <div className="modal-f">
          <button className="btn btn-out" type="button" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button className="btn" type="button" onClick={() => void submit()} disabled={busy || invalid}>
            {busy ? "처리 중" : "반려"}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function ApplicationDetailPage() {
  const { sellerId } = useParams<{ sellerId: string }>();
  const { me } = useAdmin();
  const canModerate = adminCan(me.role, "seller.moderate");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [reject, setReject] = useState(false);
  const [approving, setApproving] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const [d, rv] = await Promise.all([
      adminApi<{ seller: SellerDetail }>(`/api/admin/sellers/${encodeURIComponent(sellerId)}`),
      adminApi<{ sellers: ReviewRow[] }>("/api/admin/sellers/review"),
    ]);
    if (!d.ok) return setState({ kind: "error", status: d.status });
    const reasons = rv.ok ? (rv.data.sellers.find((x) => x.id === sellerId)?.reviewReasons ?? []) : [];
    setState({ kind: "ok", seller: d.data.seller, reasons });
  }, [sellerId]);
  useEffect(() => void load(), [load]);

  const stale = () => {
    setReject(false);
    setToast({ text: "다른 곳에서 이미 처리됐습니다. 최신 상태를 불러옵니다.", neg: true });
    void load();
  };
  const approve = async () => {
    if (approving) return;
    setApproving(true);
    const r = await adminApi(`/api/admin/sellers/${encodeURIComponent(sellerId)}/approve`, { method: "POST", json: {} });
    setApproving(false);
    if (r.ok) {
      setToast({ text: "가입을 승인했습니다." });
      return void load();
    }
    if (r.status === 404 || r.status === 409) return stale();
    setToast({ text: failMessage(r, "승인하지 못했습니다. 잠시 후 다시 시도해 주십시오."), neg: true });
  };

  const s = state.kind === "ok" ? state.seller : null;
  const biz = s?.businessInfo ?? null;
  const pending = s?.status === "PENDING";

  return (
    <>
      <AdminTopbar crumb="파트너스 › 가입 신청 › 가입 신청 상세" />
      <main className="main">
        <PageHead
          title={s ? s.shopName : "가입 신청 상세"}
          actions={
            <>
              {s && canModerate && pending && (
                <>
                  <button className="btn btn-out" type="button" onClick={() => setReject(true)} disabled={approving}>
                    반려
                  </button>
                  <button className="btn" type="button" onClick={() => void approve()} disabled={approving}>
                    {approving ? "처리 중" : "승인"}
                  </button>
                </>
              )}
              <Link className="btn btn-out" href="/admin/partners/applications">
                가입 신청 목록
              </Link>
            </>
          }
        />
        {!s ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={4} />}
            {state.kind === "error" &&
              (state.status === 404 ? (
                <div className="st">
                  <span className="t">가입 신청을 찾을 수 없습니다.</span>
                </div>
              ) : (
                <ErrorState title="가입 신청을 불러오지 못했습니다." onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <div className="col" style={{ gap: 20 }}>
            {!pending && (
              <div className="card pad" role="status" data-testid="application-processed">
                이미 처리된 신청입니다. 현재 상태는 「{SELLER_STATUS[s.status].label}」입니다.{" "}
                <Link className="fw6" href={`/admin/partners/${s.id}`}>
                  파트너스 상세 보기
                </Link>
              </div>
            )}
            {pending && (
              <Info
                title="확인 필요 항목"
                id="application-reasons"
                rows={[
                  [
                    "자동 점검",
                    state.kind === "ok" && state.reasons.length > 0 ? (
                      <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
                        {state.reasons.map((c) => (
                          <span key={c} className="bdg b-warn">
                            {reasonLabel(c)}
                          </span>
                        ))}
                      </span>
                    ) : (
                      "걸린 항목이 없습니다."
                    ),
                  ],
                ]}
              />
            )}
            <Info
              title="신청 내용"
              id="application-basic"
              rows={[
                ["쇼핑몰 주소", s.slug],
                ["상태", <span key="st" className={`bdg ${SELLER_STATUS[s.status].cls}`}>{SELLER_STATUS[s.status].label}</span>],
                ["요금제", s.plan?.name ?? "-"],
                ["신청일", dayTime(s.createdAt)],
                ...(s.status === "REJECTED" ? ([["반려 사유", text(s.rejectedReason)], ["반려일", day(s.rejectedAt)]] as [string, React.ReactNode][]) : []),
              ]}
            />
            <Info
              title="대표자"
              id="application-owner"
              rows={[
                ["이름", s.owner?.name ?? "-"],
                ["이메일", s.owner?.email ?? "-"],
              ]}
            />
            <Info
              title="사업자 정보"
              id="application-business"
              rows={[
                ["상호", text(biz?.companyName)],
                ["사업자등록번호", text(biz?.businessNumber)],
                ["대표자명", text(biz?.representativeName)],
                ["개업일", text(biz?.openedOn)],
                ["통신판매업 신고번호", text(biz?.mailOrderNumber)],
                ["국세청 확인", biz?.businessInfoValid === true ? "일치" : biz?.businessInfoValid === false ? "불일치" : "확인 못함"],
                ["통신판매업 조회", text(biz?.mailOrderStatus)],
                ["점검 시각", dayTime(typeof biz?.checkedAt === "string" ? biz.checkedAt : null)],
              ]}
            />
          </div>
        )}
      </main>
      {reject && s && (
        <RejectDialog
          id={s.id}
          shopName={s.shopName}
          onClose={() => setReject(false)}
          onDone={() => {
            setReject(false);
            setToast({ text: "가입을 반려했습니다." });
            void load();
          }}
          onStale={stale}
        />
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
