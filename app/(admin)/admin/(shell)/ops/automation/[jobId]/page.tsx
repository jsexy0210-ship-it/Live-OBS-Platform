"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageHead, useConfirm, ListTable, ListHead } from "../../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../../components/seller/States";
import { STEP_LABEL } from "../../../../../../../components/seller/automation/common";
import { adminApi, failMessage } from "../../../../_components/api";
import { AdminTopbar } from "../../../../_components/AdminShell";
import { JOB_STATUS, PAY_STATUS } from "../../../../_components/automation";
import { dayTime } from "../../../../_components/partners";
import { useSmartBack } from "../../../../../../../lib/client/navigation";

// MA-111 자동 연결 작업 상세. API: GET /api/automation/admin/jobs/{id}(조회만), POST …/cleanup(정리 필요 닫기, 운영 역할 이상).
// 보드에 있고 서버에 없는 것(재시도·담당 작업 서버 바꾸기·취소 버튼, 격리·안전 표, 작업 로그 문구)은 넣지 않았다. 흐름은 진행 기록으로 보인다.
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
  const { confirm } = useConfirm();
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const load = useCallback(async () => {
    const r = await adminApi<Detail>(`/api/automation/admin/jobs/${jobId}`);
    setState(r.ok ? { kind: "ok", d: r.data } : { kind: "error", status: r.status });
  }, [jobId]);
  useEffect(() => {
    void load();
  }, [load]);

  const closeCleanup = async () => {
    const ok = await confirm({
      title: "정리 필요 작업을 닫으시겠습니까?",
      body: "적은 내용이 기록에 남고 이 작업의 「정리 필요」 표시가 사라집니다",
      confirmLabel: "닫기",
      run: async () => {
        const r = await adminApi<unknown>(`/api/automation/admin/jobs/${jobId}/cleanup`, { method: "POST", json: { note: note.trim() } });
        return r.ok ? undefined : failMessage(r);
      },
    });
    if (!ok) return;
    setNote("");
    setToast({ text: "정리 필요 작업을 닫았습니다." });
    await load();
  };

  const crumb = "운영 › 자동 연결 작업 › 상세";
  if (state.kind !== "ok") {
    return (
      <>
        <AdminTopbar crumb={crumb} />
        <main className="main">
          <PageHead description="자동 연결 작업의 단계별 진행과 실행 기록을 확인합니다." title="자동 연결 작업 상세" />
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
        <PageHead description="자동 연결 작업의 단계별 진행과 실행 기록을 확인합니다." title={`자동 연결 작업 상세 · ${d.shopName}`} actions={<button className="btn btn-out btn-level-secondary" type="button" onClick={back}>목록</button>} />
        <div className="col" style={{ gap: 16 }}>
          <div className="card pad col" style={{ gap: 4 }}>
            <span><b>{d.shopName}</b> · {KIND[d.kind] ?? d.kind} <span className={`bdg ${s.cls}`} data-testid="detail-status">{s.label}</span></span>
            <span className="t-c1 c-alt">{d.shopHost ?? "쇼핑몰 주소 없음"} · {dayTime(d.createdAt)} 접수 · {d.attempts}번째 시도(최대 {d.maxAttempts})</span>
            {d.lastError && <span className="t-c1 c-alt">문제 이유: {d.lastError}</span>}
          </div>
          {d.status === "CLEANUP_NEEDED" && (
            <section className="card pad col" style={{ gap: 8 }} data-testid="cleanup-box">
              <b>정리 필요</b>
              <span className="t-l2 c-alt">외부 쇼핑몰에 남은 연결과 OBS 설정을 직접 지운 뒤 닫아 주십시오. 닫으면 이 작업은 실패로 끝나고, 결제는 환불 대기로 바뀝니다. 파트너스가 취소한 작업은 「취소」로 닫힙니다.</span>
              <textarea className="inp" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="정리 내용 입력" aria-description="정리한 내용은 필수이며 500자까지 입력할 수 있습니다." aria-label="정리한 내용" />
              <div><button className="btn" type="button" disabled={!note.trim()} onClick={() => void closeCleanup()}>정리 완료로 닫기</button></div>
            </section>
          )}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 16 }}>
            <section className="au-list-section">
              <h2 className="t-hl1 pad-l">진행 기록</h2>
              <>
                <ListHead total={d.events.length} loaded />
                <ListTable><table className="tbl">
                <thead><tr><th>시각</th><th>바뀌기 전</th><th>바뀐 뒤</th></tr></thead>
                <tbody>
                  {d.events.map((e) => (
                    <tr key={e.id}><td>{dayTime(e.at)}</td><td>{label(e.from)}</td><td>{label(e.to)}</td></tr>
                  ))}
                </tbody>
              </table></ListTable>
              </>
            </section>
            <section className="card pad col" style={{ gap: 6 }}>
              <h2 className="t-hl1">지금 단계 · 결제 · 비용</h2>
              <span>단계 {d.stepNumber}/{d.stepCount}{d.step ? ` · ${STEP_LABEL[d.step] ?? d.step}` : ""}{d.customerAction ? ` · 고객이 할 일: ${d.customerAction}` : ""}</span>
              <span>결제 {pay ? <span className={`bdg ${pay.cls}`}>{pay.label}</span> : "없음"}{d.payment ? ` · ${d.payment.amount.toLocaleString("ko-KR")}원` : ""}</span>
              {d.payment?.refundReason && <span className="t-c1 c-alt">환불 이유: {d.payment.refundReason}{d.payment.refundRequestedAt ? ` · 요청 ${dayTime(d.payment.refundRequestedAt)}` : ""}{d.payment.refundedAt ? ` · 완료 ${dayTime(d.payment.refundedAt)}` : ""}</span>}
              <span>AI 호출 {d.plannerCalls}회 · 비용 {d.costUsed.toLocaleString("ko-KR")}원 (한 작업 최대 {d.costLimit.toLocaleString("ko-KR")}원)</span>
              <span className="t-c1 c-alt">{d.verifiedAt ? `테스트 주문 확인 ${dayTime(d.verifiedAt)}` : "테스트 주문 확인 전"}{d.finishedAt ? ` · 종료 ${dayTime(d.finishedAt)}` : ""}</span>
            </section>
          </div>
        </div>
        {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
      </main>
    </>
  );
}
