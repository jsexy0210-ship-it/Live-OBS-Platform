"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageHead } from "../../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../../components/seller/States";
import { STEP_LABEL } from "../../../../../../../components/seller/automation/common";
import { adminApi, failMessage } from "../../../../_components/api";
import { AdminTopbar } from "../../../../_components/AdminShell";
import { JOB_STATUS, PAY_STATUS } from "../../../../_components/automation";
import { dayTime } from "../../../../_components/partners";
import { useSmartBack } from "../../../../../../../lib/client/navigation";

// MA-111 자동 연결 작업 상세. API: GET /api/automation/admin/jobs/{id}(조회만), POST …/cleanup(정리 필요 닫기, 운영 역할 이상).
// 보드에 있고 서버에 없는 것(재시도·담당 작업 서버 바꾸기·취소 버튼, 격리·안전 표, 작업 로그 문구)은 넣지 않았다. 흐름은 상태 전이 기록으로 보인다.
type Detail = {
  id: string;
  shopName: string;
  shopHost: string | null;
  kind: string;
  status: string;
  step: string | null;
  stepNumber: number;
  stepCount: number;
  customerAction: string | null;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  plannerCalls: number;
  costUsed: number;
  costLimit: number;
  cleanupNeededAt: string | null;
  verifiedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  payment: { status: string; amount: number; refundReason: string | null; refundRequestedAt: string | null; refundedAt: string | null } | null;
  events: { id: string; from: string | null; to: string; at: string }[];
};
const KIND: Record<string, string> = { INITIAL: "처음 연결", REINSTALL: "재설치(유료)", RECONNECT_FREE: "무료 재연결" };
const label = (s: string | null) => (s ? (JOB_STATUS[s]?.label ?? s) : "접수");

export default function AutomationJobDetailPage() {
  const back = useSmartBack("/admin/ops/automation");
  const { jobId } = useParams<{ jobId: string }>();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; d: Detail }>({ kind: "loading" });
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const load = useCallback(async () => {
    const r = await adminApi<Detail>(`/api/automation/admin/jobs/${jobId}`);
    setState(r.ok ? { kind: "ok", d: r.data } : { kind: "error", status: r.status });
  }, [jobId]);
  useEffect(() => {
    void load();
  }, [load]);

  const closeCleanup = async () => {
    setBusy(true);
    const r = await adminApi<unknown>(`/api/automation/admin/jobs/${jobId}/cleanup`, { method: "POST", json: { note: note.trim() } });
    setBusy(false);
    if (!r.ok) return setToast({ text: failMessage(r), neg: true });
    setNote("");
    setToast({ text: "정리 필요 작업을 닫았습니다" });
    await load();
  };

  const crumb = "운영 › 자동 연결 작업 › 상세";
  if (state.kind !== "ok") {
    return (
      <>
        <AdminTopbar crumb={crumb} />
        <main className="main">
          <PageHead title="자동 연결 작업 상세" />
          <div className="card">
            {state.kind === "loading" ? <LoadingRows rows={5} /> : state.status === 404 ? <ErrorState title="작업을 찾을 수 없습니다." onRetry={() => void load()} /> : <ErrorState title="불러오지 못했습니다." onRetry={() => void load()} />}
          </div>
        </main>
      </>
    );
  }
  const d = state.d;
  const s = JOB_STATUS[d.status] ?? { label: d.status, cls: "b-gray" };
  const pay = d.payment ? (PAY_STATUS[d.payment.status] ?? { label: d.payment.status, cls: "b-gray" }) : null;
  return (
    <>
      <AdminTopbar crumb={crumb} />
      <main className="main">
        <PageHead title={`자동 연결 작업 상세 · ${d.shopName}`} actions={<button className="btn btn-out" type="button" onClick={back}>목록</button>} />
        <div className="col" style={{ gap: 16 }}>
          <div className="card pad col" style={{ gap: 4 }}>
            <span><b>{d.shopName}</b> · {KIND[d.kind] ?? d.kind} <span className={`bdg ${s.cls}`} data-testid="detail-status">{s.label}</span></span>
            <span className="t-c1 c-alt">{d.shopHost ?? "쇼핑몰 주소 없음"} · {dayTime(d.createdAt)} 접수 · {d.attempts}번째 시도(최대 {d.maxAttempts})</span>
            {d.lastError && <span className="t-c1 c-alt">사유 코드 {d.lastError}</span>}
          </div>
          {d.status === "CLEANUP_NEEDED" && (
            <section className="card pad col" style={{ gap: 8 }} data-testid="cleanup-box">
              <b>정리 필요</b>
              <span className="t-l2 c-alt">쇼핑몰 앱 · 웹훅 · OBS 소스를 사람이 정리한 뒤 닫습니다. 닫으면 실패로 끝나고 결제는 환불 대기로 넘어갑니다(판매자가 취소한 작업은 취소로 닫습니다).</span>
              <textarea className="inp" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="정리한 내용(필수, 500자까지)" aria-label="정리한 내용" />
              <div><button className="btn" type="button" disabled={busy || !note.trim()} onClick={() => void closeCleanup()}>정리 완료로 닫기</button></div>
            </section>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
            <section className="card">
              <h2 className="t-hl1 pad-l">상태 전이 기록</h2>
              <table className="tbl">
                <thead><tr><th>시각</th><th>이전</th><th>이후</th></tr></thead>
                <tbody>
                  {d.events.map((e) => (
                    <tr key={e.id}><td>{dayTime(e.at)}</td><td>{label(e.from)}</td><td>{label(e.to)}</td></tr>
                  ))}
                </tbody>
              </table>
            </section>
            <section className="card pad col" style={{ gap: 6 }}>
              <h2 className="t-hl1">현재 단계 · 결제 · 비용</h2>
              <span>단계 {d.stepNumber}/{d.stepCount}{d.step ? ` · ${STEP_LABEL[d.step] ?? d.step}` : ""}{d.customerAction ? ` · 고객 확인: ${d.customerAction}` : ""}</span>
              <span>결제 {pay ? <span className={`bdg ${pay.cls}`}>{pay.label}</span> : "없음"}{d.payment ? ` · ${d.payment.amount.toLocaleString("ko-KR")}원` : ""}</span>
              {d.payment?.refundReason && <span className="t-c1 c-alt">환불 사유 {d.payment.refundReason}{d.payment.refundRequestedAt ? ` · 요청 ${dayTime(d.payment.refundRequestedAt)}` : ""}{d.payment.refundedAt ? ` · 완료 ${dayTime(d.payment.refundedAt)}` : ""}</span>}
              <span>판단 모델 호출 {d.plannerCalls}회 · 비용 {d.costUsed.toLocaleString("ko-KR")}원 / 작업 상한 {d.costLimit.toLocaleString("ko-KR")}원</span>
              <span className="t-c1 c-alt">{d.verifiedAt ? `테스트 표시 확인 ${dayTime(d.verifiedAt)}` : "테스트 표시 확인 전"}{d.finishedAt ? ` · 종료 ${dayTime(d.finishedAt)}` : ""}</span>
            </section>
          </div>
        </div>
        {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
      </main>
    </>
  );
}
