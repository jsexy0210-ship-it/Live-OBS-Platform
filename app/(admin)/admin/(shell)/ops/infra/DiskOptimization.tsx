"use client";

import { useEffect, useRef, useState } from "react";
import { useConfirm } from "../../../../../../components/admin-ui";
import { adminApi, failMessage } from "../../../_components/api";
import { formatDateTime } from "../../../../../../lib/client/format";

type Preview = { candidateFingerprint: string; expiresAt: string; estimatedReclaimedBytes: number; candidates: { category: string; bytes: number }[] };
type Job = { id: string; state: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED"; completedAt: string | null; reclaimedBytes: number | null; errorCode: string | null };
const policy = { actionId: "OPTIMIZE_APPROVED_ARTIFACTS_V1", policyVersion: "ONQ_DISK_SAFE_V1" };
const base = "/api/admin/infra/disk-optimization";
const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MiB`;
const stateLabel = { QUEUED: "접수됨", RUNNING: "정리 중", SUCCEEDED: "완료", FAILED: "실패" };

export default function DiskOptimization() {
  const { confirm } = useConfirm();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("정리 대상을 확인해 주십시오. 서버 연결이 확인되기 전에는 실행하지 않습니다.");
  const [now, setNow] = useState(Date.now());
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const request = useRef<{ fingerprint: string; expiresAt: string; id: string } | null>(null);
  const expired = !!preview && Date.parse(preview.expiresAt) <= now;
  const pending = job?.state === "QUEUED" || job?.state === "RUNNING";
  useEffect(() => {
    if (!preview) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [preview?.expiresAt]);
  useEffect(() => () => { sequence.current++; }, []);
  useEffect(() => {
    if (!job || !pending) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const r = await adminApi<{ job: Job }>(`${base}/jobs/${encodeURIComponent(job.id)}`);
      if (!active) return;
      if (r.ok) setJob(r.data.job);
      else setMessage(r.status === 503 ? "실제 작업 결과를 확인하지 못했습니다. 완료 여부는 아직 알 수 없습니다." : failMessage(r));
      if (active && (!r.ok || r.data.job.state === "QUEUED" || r.data.job.state === "RUNNING")) timer = setTimeout(read, 5000);
    };
    timer = setTimeout(read, 5000);
    return () => { active = false; clearTimeout(timer); };
  }, [job?.id, pending]);
  async function check() {
    if (inFlight.current || busy || pending) return;
    const seq = ++sequence.current;
    inFlight.current = true; setBusy(true); setPreview(null); request.current = null;
    const r = await adminApi<Preview>(`${base}/preview`, { method: "POST", json: policy });
    if (sequence.current !== seq) return;
    inFlight.current = false; setBusy(false);
    if (r.ok) { setPreview(r.data); setMessage("아래 두 범주만 정리합니다. 실행 직전에 같은 대상을 다시 확인합니다."); }
    else setMessage(r.status === 503 ? "테스트 서버와 전용 작업 연결이 아직 확인되지 않아 대상 확인과 실행을 사용할 수 없습니다." : failMessage(r));
  }
  function execute() {
    if (!preview || expired || busy || pending) return;
    const snapshot = preview;
    confirm({ title: "확인한 대상만 정리할까요?", body: "롤백에 필요하지 않은 오래된 ONQ 앱 이미지와 14일을 넘긴 러너 진단 로그만 정리합니다. 백업·데이터베이스·롤백 이미지·공유 캐시·작업 폴더는 보존합니다.", confirmLabel: "정리 실행", run: async () => {
      if (inFlight.current || busy || pending || preview !== snapshot || Date.parse(snapshot.expiresAt) <= Date.now()) { setMessage("대상 확인 시간이 지났습니다. 다시 확인해 주십시오."); return; }
      const seq = ++sequence.current;
      // 응답이 끊겨도 같은 후보의 재시도는 같은 키를 사용한다.
      if (!request.current || request.current.fingerprint !== snapshot.candidateFingerprint || request.current.expiresAt !== snapshot.expiresAt) request.current = { fingerprint: snapshot.candidateFingerprint, expiresAt: snapshot.expiresAt, id: crypto.randomUUID() };
      inFlight.current = true; setBusy(true);
      const r = await adminApi<{ job: Job }>(`${base}/execute`, { method: "POST", json: { ...policy, idempotencyKey: request.current.id, candidateFingerprint: snapshot.candidateFingerprint, previewExpiresAt: snapshot.expiresAt } });
      if (sequence.current !== seq) return;
      inFlight.current = false; setBusy(false);
      if (r.ok) { setJob(r.data.job); setPreview(null); setMessage("작업을 접수했습니다. 실제 결과가 도착하면 표시합니다."); }
      else { if (r.status === 409) setPreview(null); setMessage(r.status === 503 ? "실행 접수 결과를 확인하지 못했습니다. 정리 완료로 표시하지 않습니다." : r.status === 409 ? "대상이 바뀌거나 확인 시간이 지났습니다. 다시 확인해 주십시오." : failMessage(r)); }
    } });
  }
  return <section className="card" aria-labelledby="infra-cleanup" style={{ padding: 16 }}>
    <h2 className="t-hl1" id="infra-cleanup">디스크 수동 정리</h2>
    <p className="t-c1 c-alt">테스트 서버의 오래된 앱 이미지와 14일 초과 진단 로그만 대상으로 합니다. 자동 정리는 꺼져 있습니다.</p>
    <p role="status" aria-live="polite">{message}</p>
    {preview && <>
      <dl className="col" style={{ gap: 8 }}>
        <div><dt>롤백 보호 밖 오래된 앱 이미지</dt><dd>{preview.candidates.filter(c => c.category === "OLD_ONQ_NON_ROLLBACK_IMAGES").length}개</dd></div>
        <div><dt>14일 초과 러너 진단 로그</dt><dd>{preview.candidates.filter(c => c.category === "RUNNER_DIAGNOSTIC_LOGS_OLDER_THAN_14_DAYS").length}개</dd></div>
        <div><dt>예상 정리 크기</dt><dd>{bytes(preview.estimatedReclaimedBytes)} · 공유 레이어로 실제 회수량과 다를 수 있습니다</dd></div>
        <div><dt>확인 유효 시각</dt><dd>{formatDateTime(preview.expiresAt)}{expired && " · 다시 확인 필요"}</dd></div>
      </dl>
    </>}
    <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
      <button className="btn" disabled={busy || pending} onClick={check}>{busy ? "확인 중…" : "정리 대상 확인"}</button>
      <button className="btn pri" disabled={!preview || !preview.candidates.length || expired || busy || pending} onClick={execute}>정리 실행</button>
    </div>
    {job && <p role="status">작업 {job.id} · {stateLabel[job.state]}{job.state === "SUCCEEDED" && job.reclaimedBytes !== null ? ` · 실제 회수 ${bytes(job.reclaimedBytes)} · ${formatDateTime(job.completedAt)}` : ""}{job.state === "FAILED" ? ` · ${job.errorCode ?? "결과 오류"}` : ""}</p>}
  </section>;
}
