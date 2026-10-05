"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { ACTION_TEXT, STEP_LABEL, errorText, stamp, type Job } from "../../../../../../components/seller/automation/common";
import { AUTOMATION_PRICE } from "../../../../../../lib/server/automation/config";

// SA-152 자동 연결 진행. API: GET /api/automation/jobs/{id}(5초마다), POST …/resume · …/cancel · …/refund-request. 끝나면(성공) 완료 화면으로 보낸다.
// 보드에 있고 서버에 없는 것(작업 기록 목록, 관리자 창 열기, 도구 내려받기, 잠시 멈추기, 취소 때 되돌린 항목 목록)은 넣지 않았다.
const STEPS = ["shop_connect", "webhook_setup", "obs_overlay_install", "display_settings", "test_event_verify"];
const TAG: Record<string, { label: string; cls: string }> = {
  AWAITING_PAYMENT: { label: "결제 확인 중", cls: "b-wait" },
  QUEUED: { label: "순서 기다리는 중", cls: "b-wait" },
  RUNNING: { label: "설정하는 중", cls: "b-live" },
  VERIFYING: { label: "확인하는 중", cls: "b-live" },
  NEEDS_CUSTOMER: { label: "직접 해 주셔야 함", cls: "b-warn" },
  SUCCEEDED: { label: "완료", cls: "b-done" },
  FAILED: { label: "실패", cls: "b-fail" },
  CANCELED: { label: "취소됨", cls: "b-gray" },
  CLEANUP_NEEDED: { label: "되돌리는 중", cls: "b-warn" },
};

export default function AutomationProgressPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const router = useRouter();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; job: Job }>({ kind: "loading" });
  const { confirm } = useConfirm();
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const load = useCallback(async () => {
    const r = await api<Job>(`/api/automation/jobs/${jobId}`);
    if (!r.ok) return setState((s) => (s.kind === "ok" && r.status === 0 ? s : { kind: "error", status: r.status }));
    setState({ kind: "ok", job: r.data });
    if (r.data.status === "SUCCEEDED") router.replace(`/seller/automation/${jobId}/done`);
  }, [jobId, router]);
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  // 서버에 쓰는 행동은 모두 공용 확인 창을 거친다
  const act = async (path: string, ok: string, ask: { title: string; body: string; confirmLabel: string; danger?: boolean }) => {
    const done = await confirm({
      ...ask,
      run: async () => {
        const r = await api<unknown>(`/api/automation/jobs/${jobId}/${path}`, { method: "POST" });
        if (r.ok) return;
        void load();
        return failMessage(r, "admin", "처리하지 못했습니다. 잠시 후 다시 시도해 주십시오");
      },
    });
    if (!done) return;
    setToast({ text: ok });
    await load();
  };

  if (state.kind !== "ok") {
    return (
      <>
        <Topbar crumb="방송 › 연동 › 자동 연결 › 자동 연결 진행" />
        <main className="main">
          <PageHead title="자동 연결 진행" />
          <div className="card">{state.kind === "loading" ? <LoadingRows rows={4} /> : <ErrorState title="진행 상황을 불러오지 못했습니다" onRetry={() => void load()} />}</div>
        </main>
      </>
    );
  }
  const j = state.job;
  const tag = TAG[j.status];
  const idx = j.stepNumber - 1;
  const terminal = j.status === "FAILED" || j.status === "CANCELED";
  const cancelable = ["QUEUED", "RUNNING", "NEEDS_CUSTOMER", "VERIFYING"].includes(j.status);
  const refundable = j.paymentStatus === "PAID" && (j.status === "FAILED" || (j.status === "CANCELED" && !j.verifiedAt));

  return (
    <>
      <Topbar crumb="방송 › 연동 › 자동 연결 › 자동 연결 진행" />
      <main className="main">
        <PageHead
          title="자동 연결 진행"
          actions={cancelable && <button className="btn btn-out" type="button" onClick={() => void act("cancel", "자동 연결을 취소했습니다", { title: "자동 연결을 취소하시겠습니까?", body: j.status === "QUEUED" ? "아직 연결을 시작하지 않았습니다. 취소한 뒤 환불을 요청할 수 있습니다." : "진행을 멈추고 지금까지 바꾼 설정을 되돌립니다. 설정을 시작한 뒤라 환불되지 않습니다 · 결제 전에 동의하신 내용입니다.", confirmLabel: "그만두기", danger: true })}>자동 설정 그만두기</button>}
        />
        <div className="col" style={{ gap: 16 }}>
          <div className={`msg ${j.status === "NEEDS_CUSTOMER" ? "msg-cau" : terminal ? "msg-neg" : "msg-info"}`} role="status" data-testid="job-status">
            <span>
              <span className={`bdg ${tag.cls}`}>{tag.label}</span> {stamp(j.createdAt)} 시작 · 결제 {j.paymentStatus === "PAID" ? "확인됨" : j.paymentStatus === "REFUND_PENDING" ? "환불 처리 중" : j.paymentStatus === "REFUNDED" ? "환불 완료" : j.paymentStatus === "PENDING" ? "확인 중" : "없음"}
              {j.lastError && terminal && <> · {errorText(j.lastError)}</>}
            </span>
          </div>
          <ol className="row" style={{ gap: 12, flexWrap: "wrap", listStyle: "none", padding: 0, margin: 0 }} aria-label="진행 단계">
            <li className="c-alt">✓ 결제 확인</li>
            {STEPS.map((s, i) => (
              <li key={s} aria-current={i === idx && !terminal ? "step" : undefined} style={{ fontWeight: i === idx && !terminal ? 700 : 400, color: i < idx ? "var(--ok, #1b7f3b)" : undefined }}>
                {i < idx ? "✓ " : `${i + 2} `}
                {STEP_LABEL[s]}
              </li>
            ))}
          </ol>
          {j.status === "NEEDS_CUSTOMER" && j.customerAction && (
            <section className="card pad col" style={{ gap: 8 }} data-testid="job-action">
              <b>지금 해 주실 일</b>
              <span>{ACTION_TEXT[j.customerAction]}</span>
              <span className="t-c1 c-alt">
                아이디 · 비밀번호는 저장하지 않습니다{j.actionDeadlineAt ? ` · ${stamp(j.actionDeadlineAt)}까지 확인해 주십시오` : ""} · 마친 뒤 이어서 진행하기를 누르면 자동으로 이어 갑니다
              </span>
              <div><button className="btn" type="button" onClick={() => void act("resume", "이어서 진행합니다", { title: "이어서 진행하시겠습니까?", body: "직접 해 주실 일을 마쳤다면 자동 설정을 다시 시작합니다.", confirmLabel: "이어서 진행하기" })}>이어서 진행하기</button></div>
            </section>
          )}
          {(j.status === "QUEUED" || j.status === "AWAITING_PAYMENT") && <div className="msg msg-info" role="note"><span><b>{j.status === "QUEUED" ? "순서를 기다리고 있습니다" : "결제를 확인하고 있습니다"}</b> · 창을 닫아도 진행됩니다 · 결제가 확인되기 전에는 작업이 시작되지 않습니다</span></div>}
          {j.status === "VERIFYING" && <div className="msg msg-info" role="note"><span><b>테스트 주문 이벤트를 보냈습니다</b> · OBS 오버레이에 「테스트 주문」이 보이는지 확인하고 있습니다</span></div>}
          {j.status === "CLEANUP_NEEDED" && <div className="msg msg-cau" role="note"><span><b>바꾼 설정을 원래대로 되돌리고 있습니다.</b> 끝나면 알려 드립니다</span></div>}
          {terminal && (
            <section className="card pad col" style={{ gap: 8 }} data-testid="job-ended">
              {j.status === "FAILED" ? <b>{errorText(j.lastError) || "자동 연결을 끝내지 못했습니다"}</b> : <b>자동 연결을 취소했습니다</b>}
              <span className="t-c1 c-alt">
                {j.paymentStatus === "REFUND_PENDING" || j.paymentStatus === "REFUNDED"
                  ? `${AUTOMATION_PRICE.toLocaleString("ko-KR")}원은 결제한 카드로 환불됩니다 · 카드사 기준 3~5일(주말·공휴일 제외) · 직접 설정은 무료로 계속 할 수 있습니다`
                  : j.status === "CANCELED" && j.paymentStatus === "PAID" && !refundable
                    ? "설정을 시작한 뒤라 환불되지 않습니다 · 결제 전에 동의하신 내용입니다"
                    : "직접 설정은 무료로 계속 할 수 있습니다"}
              </span>
              <div className="row" style={{ gap: 8 }}>
                {refundable && <button className="btn" type="button" onClick={() => void act("refund-request", "환불을 요청했습니다", { title: `${AUTOMATION_PRICE.toLocaleString("ko-KR")}원 환불을 요청하시겠습니까?`, body: "결제한 카드로 환불되며 카드사 기준 3~5영업일 걸립니다. 요청한 뒤에는 되돌릴 수 없습니다.", confirmLabel: "환불 요청하기", danger: true })}>{AUTOMATION_PRICE.toLocaleString("ko-KR")}원 환불 요청하기</button>}
                <Link className="btn btn-out" href="/seller/automation">자동 설정 다시 하기</Link>
                <Link className="btn btn-out" href="/seller">직접 설정하러 가기</Link>
              </div>
            </section>
          )}
        </div>
        {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
      </main>
    </>
  );
}
