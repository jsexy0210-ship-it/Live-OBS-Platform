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

// MA-083 점검 모드(GET·PUT /api/admin/settings/maintenance). 보기는 모든 마스터 역할, 켜기·끄기·바꾸기는 최고관리자만(system.manage).
// 켜면 파트너스 관리자·쇼핑몰·가입 신청이 막힌다(마스터 관리자·오버레이는 열림, 반영까지 최대 5초). 종료 시각은 안내용이라 지나도 저절로 꺼지지 않는다.
const MESSAGE_MAX = 500;
type Maintenance = {
  active: boolean;
  scheduled: boolean;
  enabled: boolean;
  message: string;
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
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"on" | "off" | null>(null);
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);

  const fill = (m: Maintenance) => {
    setMessage(m.message);
    setStartsAt(toLocal(m.startsAt));
    setEndsAt(toLocal(m.endsAt));
  };
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    const r = await adminApi<{ maintenance: Maintenance }>("/api/admin/settings/maintenance");
    if (id !== reqId.current) return;
    if (r.ok) {
      fill(r.data.maintenance);
      setState({ kind: "ok", data: r.data.maintenance });
    } else setState({ kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  const m = state.kind === "ok" ? state.data : null;
  const count = textLength(message);
  const timeError = !!startsAt && !!endsAt && endsAt <= startsAt ? "종료 예정 시각은 시작 시각보다 뒤여야 합니다." : null;
  const invalid = count === 0 || count > MESSAGE_MAX || !!timeError;

  const put = async (enabled: boolean) => {
    if (!m || busy) return;
    setBusy(true);
    setError(null);
    const body = enabled
      ? { enabled: true, message: message.trim(), startsAt: effectiveAtIso(startsAt) ?? null, endsAt: effectiveAtIso(endsAt) ?? null, expectedVersion: m.version }
      : { enabled: false, message: message.trim(), expectedVersion: m.version };
    const r = await adminApi<{ maintenance: Maintenance }>("/api/admin/settings/maintenance", { method: "PUT", json: body });
    setBusy(false);
    if (r.ok) {
      setConfirm(null);
      fill(r.data.maintenance);
      setState({ kind: "ok", data: r.data.maintenance });
      return setToast({ text: !enabled ? "점검을 껐습니다." : m.enabled ? "점검 설정을 저장했습니다." : "점검을 켰습니다." });
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
        <PageHead title="점검 모드" />
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
          <div className="col" style={{ gap: 20 }}>
            <section className="card pad-l col" style={{ gap: 12 }} aria-labelledby="mt-state" data-testid="maintenance-state">
              <h2 className="t-hl1" id="mt-state">
                현재 상태
              </h2>
              <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span className={`bdg ${status.cls}`}>{status.label}</span>
                {m.updatedAt && (
                  <span className="t-l2 c-alt">
                    {dayTime(m.updatedAt)} · {m.updatedByAdminName ?? "관리자"}가 마지막으로 바꿨습니다.
                  </span>
                )}
              </div>
              <p className="t-l2 c-alt" style={{ margin: 0 }}>
                켜면 파트너스 관리자·쇼핑몰·파트너스 가입 신청이 막힙니다. 마스터 관리자와 방송 오버레이는 그대로 열립니다. 바꾼 내용이 반영되기까지 최대 5초 걸립니다.
              </p>
            </section>

            <section className="card pad-l col" style={{ gap: 14 }} aria-labelledby="mt-form">
              <h2 className="t-hl1" id="mt-form">
                {m.enabled ? "점검 설정" : "점검 켜기"}
              </h2>
              <div className="fld">
                <label htmlFor="mt-message">안내 문구</label>
                <textarea id="mt-message" className="inp" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} disabled={!canEdit || busy} />
                <span className={`t-c1 ${count > MESSAGE_MAX ? "c-neg" : "c-alt"}`}>
                  {count}/{MESSAGE_MAX}
                </span>
              </div>
              <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                <div className="fld">
                  <label htmlFor="mt-start">시작 시각</label>
                  <input id="mt-start" className="inp" type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} disabled={!canEdit || busy} />
                  <span className="t-c1 c-alt">비워 두면 켜는 즉시 시작합니다.</span>
                </div>
                <div className="fld">
                  <label htmlFor="mt-end">종료 예정 시각</label>
                  <input id="mt-end" className="inp" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} disabled={!canEdit || busy} />
                  <span className="t-c1 c-alt">안내용입니다. 지나도 저절로 꺼지지 않습니다.</span>
                </div>
              </div>
              {timeError && (
                <span className="err" role="alert">
                  {timeError}
                </span>
              )}
              {canEdit ? (
                <>
                  {error && (
                    <span className="err" role="alert">
                      {error}
                    </span>
                  )}
                  <div className="row" style={{ gap: 8 }}>
                    {m.enabled ? (
                      <>
                        <button className="btn" type="button" onClick={() => void put(true)} disabled={busy || invalid}>
                          {busy ? "저장 중" : "변경 저장"}
                        </button>
                        <button className="btn btn-out" type="button" onClick={() => setConfirm("off")} disabled={busy}>
                          점검 끄기
                        </button>
                      </>
                    ) : (
                      <button className="btn" type="button" onClick={() => setConfirm("on")} disabled={busy || invalid}>
                        점검 켜기
                      </button>
                    )}
                  </div>
                  {m.enabled && <span className="t-c1 c-alt">점검이 끝나면 「점검 끄기」를 눌러 주십시오. 종료 예정 시각이 지나도 자동으로 꺼지지 않습니다.</span>}
                </>
              ) : (
                <div className="card pad t-l2 c-alt" role="note">
                  점검 설정은 최고관리자만 바꿀 수 있습니다.
                </div>
              )}
            </section>
          </div>
        )}
      </main>

      {confirm && m && (
        <Modal labelId="maintenance-title" busy={busy} onClose={() => setConfirm(null)}>
          {(requestClose) => (
            <>
              <div className="modal-h">
                <h2 className="modal-t" id="maintenance-title">
                  {confirm === "on" ? "점검을 켜시겠습니까?" : "점검을 끄시겠습니까?"}
                </h2>
                <span className="t-l2 c-alt">
                  {confirm === "on"
                    ? startsAt
                      ? "시작 시각이 되면 파트너스 관리자·쇼핑몰·가입 신청이 막힙니다."
                      : "지금부터 파트너스 관리자·쇼핑몰·가입 신청이 막힙니다."
                    : "파트너스 관리자·쇼핑몰·가입 신청이 다시 열립니다."}
                </span>
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
                <button className="btn" type="button" onClick={() => void put(confirm === "on")} disabled={busy}>
                  {busy ? "처리 중" : confirm === "on" ? "점검 켜기" : "점검 끄기"}
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
