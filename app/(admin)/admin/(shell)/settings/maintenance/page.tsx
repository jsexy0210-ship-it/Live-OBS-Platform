"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { textLength } from "../../../../../../lib/server/text/clean";
import { Modal, PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminApi, failMessage } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { effectiveAtIso } from "../../../_components/messageFees";
import { dayTime } from "../../../_components/partners";
import { DateTimePicker } from "../../../../../../components/admin-ui/DatePicker";
import Link from "next/link";
import styles from "./maintenance.module.css";
import { MAINTENANCE_CHANGED } from "../../../../../../components/public/MaintenanceBanner";

// MA-083 점검 모드(GET·PUT /api/admin/settings/maintenance). 보기는 모든 마스터 역할, 켜기·끄기·바꾸기는 최고관리자만(system.manage).
// 켜면 파트너스 관리자·쇼핑몰·가입 신청이 막힌다(마스터 관리자·오버레이는 열림, 반영까지 최대 5초). 종료 시각은 안내용이라 지나도 저절로 꺼지지 않는다.
const MESSAGE_MAX = 500;
type Maintenance = {
  active: boolean;
  scheduled: boolean;
  enabled: boolean;
  message: string;
  reason: string;
  history: { id: string; at: string; action: string; reason: string; message: string }[];
  liveBroadcasts: number;
  waitingOrders: number;
  startsAt: string | null;
  endsAt: string | null;
  version: number;
  updatedAt: string | null;
  updatedByAdminName: string | null;
};
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Maintenance };

// 서버의 ISO 시각 → datetime-local 입력값(KST)
const toLocal = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() + 9 * 3_600_000).toISOString().slice(0, 16) : "");

export default function MaintenancePage() {
  const { me } = useAdmin();
  const canEdit = adminCan(me.role, "system.manage");
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [message, setMessage] = useState("");
  const [reason, setReason] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"on" | "off" | "cancel" | null>(null);
  const [confirmText, setConfirmText] = useState("");
  useEffect(() => setConfirmText(""), [confirm]);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const fill = (m: Maintenance) => {
    setMessage(m.message);
    setReason(m.reason);
    setStartsAt(toLocal(m.startsAt));
    setEndsAt(toLocal(m.endsAt));
  };
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    const r = await adminApi<{ maintenance: Maintenance }>("/api/admin/settings/maintenance");
    if (id !== reqId.current) return;
    if (r.ok) {
      window.dispatchEvent(new Event(MAINTENANCE_CHANGED));
      fill(r.data.maintenance);
      setState({ kind: "ok", data: r.data.maintenance });
    } else setState({ kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  const m = state.kind === "ok" ? state.data : null;
  const count = textLength(message);
  const timeError = !!startsAt && !!endsAt && endsAt <= startsAt ? "종료 예정 시각은 시작 시각보다 뒤여야 합니다." : null;
  const invalid = count === 0 || count > MESSAGE_MAX || !reason.trim() || textLength(reason) > 100 || !!timeError;

  const put = async (enabled: boolean, immediate = false) => {
    if (!m || busy) return;
    setBusy(true);
    setError(null);
    const body = enabled
      ? { enabled: true, reason: reason.trim(), message: message.trim(), startsAt: immediate ? null : effectiveAtIso(startsAt) ?? null, endsAt: effectiveAtIso(endsAt) ?? null, expectedVersion: m.version }
      : { enabled: false, expectedVersion: m.version };
    const r = await adminApi<{ maintenance: Maintenance }>("/api/admin/settings/maintenance", { method: "PUT", json: body });
    setBusy(false);
    if (r.ok) {
      setConfirm(null);
      fill(r.data.maintenance);
      setState({ kind: "ok", data: r.data.maintenance });
      return setToast({ text: !enabled ? m.scheduled ? "점검 예약을 취소했습니다." : "점검을 종료했습니다." : r.data.maintenance.scheduled ? "점검 예약을 저장했습니다." : m.active ? "점검 설정을 저장했습니다." : "점검을 켰습니다." });
    }
    if (r.status === 409) {
      setConfirm(null);
      setToast({ text: r.message ?? "다른 곳에서 먼저 바꿨습니다. 최신 설정을 불러옵니다.", neg: true });
      return void load();
    }
    setError(r.message ?? failMessage(r, "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };

  const status = m ? (m.active ? { label: "점검 중", cls: "b-fail" } : m.scheduled ? { label: "점검 예정", cls: "b-warn" } : { label: "꺼짐", cls: "b-gray" }) : null;

  return (
    <>
      <AdminTopbar crumb="설정 › 점검 모드" />
      <main className="main">
        <PageHead title="점검 모드" actions={status && <span className={`bdg ${status.cls}`}>{m?.active ? "점검 모드 켜짐" : "점검 모드 꺼짐"}{m?.scheduled && m.startsAt ? ` · 다음 예약 ${dayTime(m.startsAt)}` : ""}</span>} />
        {state.kind === "loading" && (
          <div className="card">
            <LoadingRows rows={4} />
          </div>
        )}
        {state.kind === "error" && (
          <div className="card">
            <ErrorState title="점검 설정을 불러오지 못했습니다." onRetry={() => void load()} />
          </div>
        )}
        {m && status && (
          <>
            <div className={styles.note} data-testid="maintenance-state">켜면 마스터 관리자를 제외한 파트너스 관리자·쇼핑몰이 「점검 중」으로 전환됩니다. 방송 화면과 주문대기 연결은 그대로 열립니다. 종료 예정 시각이 지나도 자동으로 꺼지지 않으니 「점검 종료」를 눌러 주십시오.</div>
            <div className={styles.columns} data-testid="maintenance-columns">
              <div className={styles.column} data-testid="maintenance-form-column">
                <section aria-labelledby="mt-form" data-testid="maintenance-form">
                  <h2 className={styles.section} id="mt-form">점검 모드 <span className={`bdg ${status.cls}`}>{status.label}</span></h2>
                  <div className={styles.warning}><b>지금 방송 중 {m.liveBroadcasts}개 · 대기 주문 {m.waitingOrders}건.</b> 즉시 켜기는 피하고 예약 + 사전 공지를 권장합니다.</div>
                  <table className={styles.form}><tbody>
                    <tr><th><label htmlFor="mt-start">시작 *</label></th><td><DateTimePicker id="mt-start" aria-label="시작 시각" value={startsAt} onChange={setStartsAt} disabled={!canEdit || busy} /></td></tr>
                    <tr><th><label htmlFor="mt-end">종료 (예정) *</label></th><td><DateTimePicker id="mt-end" aria-label="종료 예정 시각" value={endsAt} onChange={setEndsAt} disabled={!canEdit || busy} /></td></tr>
                    <tr><th><label htmlFor="mt-reason">사유 *</label></th><td><input id="mt-reason" className="inp" value={reason} maxLength={100} onChange={(e) => setReason(e.target.value)} disabled={!canEdit || busy} /><span className={styles.hint}>점검 화면에 표시</span></td></tr>
                    <tr><th><label htmlFor="mt-message">점검 화면 안내 문구</label></th><td><textarea id="mt-message" className="inp" rows={2} value={message} onChange={(e) => setMessage(e.target.value)} disabled={!canEdit || busy} /><span className={styles.hint}>{count}/{MESSAGE_MAX}</span></td></tr>
                    <tr><th>자동 처리</th><td><div className={styles.checks}>
                      <label><input type="checkbox" disabled />시작 10분 전 방송 중 파트너스에게 경고 배너 + 알림톡</label>
                      <label><input type="checkbox" disabled />종료 시 전체 파트너스에게 「점검 완료」 알림</label>
                      <label><input type="checkbox" disabled />마스터 관리자도 읽기 전용으로 (배포 중)</label>
                    </div><span className={styles.hint}>10분 전 방송 중 파트너스에게 경고 배너를 표시합니다. 알림톡·완료 알림·마스터 읽기 전용은 아직 연결되지 않았습니다.</span></td></tr>
                    {canEdit && <tr><th></th><td><div className={styles.actions}>
                      {m.active ? <><button className="btn" onClick={() => void put(true)} disabled={busy || invalid}>점검 안내 변경 저장</button><button className="btn btn-out" onClick={() => setConfirm("off")} disabled={busy}>점검 종료</button></> : <><button className="btn" onClick={() => void put(true)} disabled={busy || invalid || !startsAt || !endsAt || new Date(effectiveAtIso(startsAt) ?? 0) <= new Date()}>예약 저장</button><button className="btn btn-neg" onClick={() => setConfirm("on")} disabled={busy || invalid}>지금 즉시 켜기</button></>}
                      <Link className="btn btn-out" href="/admin/support/notices/new">점검 공지 작성</Link>
                    </div></td></tr>}
                  </tbody></table>
                  {timeError && <span className="err" role="alert">{timeError}</span>}
                  {error && <span className="err" role="alert">{error}</span>}
                  {!canEdit && <p className={styles.hint}>조회 전용 권한입니다 · 변경 버튼은 보이지 않습니다 · 필요한 권한: 시스템 설정</p>}
                </section>
              </div>
              <div className={styles.column} data-testid="maintenance-aside">
                <section aria-labelledby="mt-scheduled" data-testid="maintenance-schedule">
                  <h2 className={styles.section} id="mt-scheduled">예약된 점검</h2>
                  <table className={styles.table}><thead><tr><th className={styles.time}>일시</th><th>내용</th><th>상태</th>{canEdit && <th>관리</th>}</tr></thead><tbody>
                    {m.scheduled ? <tr><td>{m.startsAt ? dayTime(m.startsAt) : "—"} ~ {m.endsAt ? dayTime(m.endsAt) : "—"}</td><td>{m.reason || m.message}</td><td><span className="bdg b-warn">예약</span></td>{canEdit && <td><button className="btn btn-sm btn-out" onClick={() => setConfirm("cancel")} disabled={busy}>취소</button></td>}</tr> : <tr><td colSpan={canEdit ? 4 : 3}>예약된 점검이 없습니다.</td></tr>}
                  </tbody></table>
                </section>
                <section aria-labelledby="mt-history" data-testid="maintenance-history">
                  <h2 className={styles.section} id="mt-history">점검 이력</h2>
                  <table className={styles.table}><thead><tr><th className={styles.time}>일시</th><th>내용</th></tr></thead><tbody>
                    {m.history.length ? m.history.map((h) => <tr key={h.id}><td>{dayTime(h.at)}</td><td>{h.reason || h.message || "점검 설정"} · {h.action}</td></tr>) : <tr><td colSpan={2}>변경 기록이 없습니다.</td></tr>}
                  </tbody></table>
                </section>
                <section aria-labelledby="mt-preview" data-testid="maintenance-preview">
                  <h2 className={styles.section} id="mt-preview">점검 화면 미리보기</h2>
                  <div className={styles.preview}><b>지금은 점검 중입니다</b><p>{reason}</p><p>{message.trim() || "안내 문구를 입력해 주십시오."}</p><span className={styles.hint}>{startsAt ? startsAt.replace("T", " ").replace(/-/g, ".") : "점검을 켜면 바로 시작"} ~ {endsAt ? endsAt.replace("T", " ").replace(/-/g, ".") : "종료 예정 미정"}</span></div>
                </section>
              </div>
            </div>
          </>
        )}
      </main>

      {confirm && m && (
        <Modal labelId="maintenance-title" busy={busy} onClose={() => setConfirm(null)}>
          {(requestClose) => (
            <>
              <div className="modal-h">
                <h2 className="modal-t" id="maintenance-title">
                  {confirm === "on" ? "지금 즉시 점검 모드를 켜시겠습니까?" : confirm === "cancel" ? "점검 예약을 취소하시겠습니까?" : "점검을 종료하시겠습니까?"}
                </h2>
                <span className="t-l2 c-alt">
                  {confirm === "on"
                    ? "지금부터 파트너스 관리자·쇼핑몰·가입 신청이 막힙니다."
                    : confirm === "cancel" ? "예정된 점검을 취소합니다. 로그 추적에 남습니다." : "파트너스 관리자·쇼핑몰·가입 신청이 다시 열립니다."}
                </span>
                {confirm === "on" && <>
                  <p className="t-l2">방송 화면과 주문대기 연결은 유지됩니다. 예약 없이 켜는 즉시 점검은 긴급 장애 대응에만 사용해 주십시오.</p>
                  <p className={styles.warning}>영향 범위 (지금): 방송 중 {m.liveBroadcasts}개 · 대기 주문 {m.waitingOrders}건. 방송 자동 종료·주문 이월은 실행하지 않습니다. 파트너스 알림톡은 아직 연결되지 않았습니다.</p>
                  <p className="t-l2">사유: {reason}</p>
                  <label htmlFor="mt-confirm">확인 *</label><input id="mt-confirm" className="inp" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} disabled={busy} placeholder="점검 시작" /><span className={styles.hint}>확인을 위해 「점검 시작」을 입력합니다.</span>
                </>}
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
                <button className="btn" type="button" onClick={() => void put(confirm === "on", confirm === "on")} disabled={busy || (confirm === "on" && (confirmText !== "점검 시작" || invalid))}>
                  {busy ? "처리 중" : "실행"}
                </button>
              </div>
            </>
          )}
        </Modal>
      )}
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
