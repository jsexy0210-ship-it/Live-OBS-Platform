"use client";

import { useEffect, useState } from "react";
import { textLength } from "../../../../lib/server/text/clean";
import { FormRow } from "../../../../components/admin-ui";
import { Modal } from "../../../../components/admin-ui/Modal";
import { adminApi, failMessage } from "./api";
import { useAdmin } from "./AdminShell";
import styles from "./ImpersonateDialog.module.css";

// 대신 보기 시작 확인 창(MA-016, POST /api/admin/sellers/{id}/impersonate). 정본: design/project/MA-011.dc.html 「대신 보기 시작 확인 창」.
// 사유(1~200자) 필수 · 분류 · 관련 건(문의 대응·장애 확인이면 필수) · 범위 1개 이상 · 시간 15/30/60분(60분은 최고관리자만). 서버 입력 종류는 lib/server/auth/impersonation.ts와 같다.
// 성공하면 읽기 전용 파트너스 화면(/seller)을 새 창으로 연다. 팝업 차단을 피하려고 새 창은 누르는 순간 먼저 열고, 요청이 성공하면 주소를 넣고 실패하면 닫는다.
const MAX_REASON = 200;
type Category = "INQUIRY" | "INCIDENT" | "FINANCE_CHECK" | "AUDIT";
type Scope = "BROADCAST" | "OVERLAY" | "ORDERS" | "MEMBERS" | "SETTINGS_PG";
type RelatedKind = "INQUIRY" | "NOTIFICATION" | "REPORT";
type Related = { kind: RelatedKind; id: string; label: string };
const CATEGORIES: [Category | "", string][] = [["", "선택 안 함"], ["INQUIRY", "문의 대응"], ["INCIDENT", "장애 확인"], ["FINANCE_CHECK", "정산 확인"], ["AUDIT", "감사"]];
const SCOPES: [Scope, string][] = [["BROADCAST", "방송 대시보드"], ["OVERLAY", "오버레이"], ["ORDERS", "주문"], ["MEMBERS", "회원"], ["SETTINGS_PG", "결제 연결"]];
const RELATED_NAME: Record<RelatedKind, string> = { INQUIRY: "문의", NOTIFICATION: "알림", REPORT: "신고" };
const DURATIONS = [15, 30, 60] as const;
const stamp = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
export type ImpersonationStart = { expiresAt: string; opened: boolean };

export function ImpersonateDialog({ seller, onClose, onDone }: { seller: { id: string; shopName: string }; onClose: () => void; onDone: (r: ImpersonationStart) => void }) {
  const { me } = useAdmin();
  const isSuper = me.role === "SUPER_ADMIN";
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<Category | "">("");
  const [related, setRelated] = useState<Related[] | null>(null);
  const [relatedKey, setRelatedKey] = useState("");
  const [scopes, setScopes] = useState<Scope[]>(["ORDERS", "MEMBERS"]);
  const [minutes, setMinutes] = useState<number | null>(null); // null이면 보내지 않아 서버가 플랫폼 정책(MA-081) 기본 시간을 쓴다
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = textLength(reason);
  const needsRelated = category === "INQUIRY" || category === "INCIDENT";
  const reasonInvalid = count === 0 || count > MAX_REASON;
  const relatedMissing = needsRelated && !relatedKey;
  const scopesMissing = scopes.length === 0;

  // 관련 건 후보: 이 쇼핑몰의 문의(sellerId로 조회)와 알림(쇼핑몰 이름 검색 결과 중 같은 쇼핑몰만). 신고는 관리자 목록 API가 아직 없어 고르지 못한다.
  useEffect(() => {
    let live = true;
    void Promise.all([
      adminApi<{ items: { id: string; title: string; createdAt: string }[] }>(`/api/admin/platform-inquiries?sellerId=${seller.id}`),
      adminApi<{ items: { id: string; title: string; sellerId: string | null; occurredAt: string }[] }>(`/api/admin/alerts?seller=${encodeURIComponent(seller.shopName.slice(0, 50))}`),
    ]).then(([inq, alerts]) => {
      if (!live) return;
      const rows: Related[] = [
        ...(inq.ok ? inq.data.items.map((x) => ({ kind: "INQUIRY" as const, id: x.id, label: `${RELATED_NAME.INQUIRY} · ${x.title} · ${stamp(x.createdAt)}` })) : []),
        ...(alerts.ok ? alerts.data.items.filter((x) => x.sellerId === seller.id).map((x) => ({ kind: "NOTIFICATION" as const, id: x.id, label: `${RELATED_NAME.NOTIFICATION} · ${x.title} · ${stamp(x.occurredAt)}` })) : []),
      ];
      setRelated(rows);
    });
    return () => {
      live = false;
    };
  }, [seller.id, seller.shopName]);

  const toggleScope = (s: Scope) => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));

  const submit = async () => {
    if (busy) return;
    if (reasonInvalid || relatedMissing || scopesMissing) return;
    setBusy(true);
    setError(null);
    const pick = related?.find((x) => `${x.kind}:${x.id}` === relatedKey);
    const win = window.open("", "_blank");
    const r = await adminApi<{ expiresAt: string }>(`/api/admin/sellers/${seller.id}/impersonate`, {
      method: "POST",
      json: { reason: reason.trim(), ...(category ? { category } : {}), ...(pick ? { relatedKind: pick.kind, relatedId: pick.id } : {}), scopes, ...(minutes !== null ? { durationMinutes: minutes } : {}) },
    });
    setBusy(false);
    if (r.ok) {
      if (win) win.location.href = "/seller";
      return onDone({ expiresAt: r.data.expiresAt, opened: !!win });
    }
    win?.close();
    setError(
      r.error === "reason_required"
        ? "사유를 1자 이상 200자 이하로 입력해 주십시오."
        : r.error === "related_required" || r.error === "related_invalid"
          ? "관련 건을 선택해 주십시오."
          : r.error === "scopes_required"
            ? "범위를 1개 이상 골라 주십시오."
            : r.error === "duration_not_allowed"
              ? "60분은 최고관리자만 고를 수 있습니다."
              : r.error === "seller_not_viewable"
                ? "이 파트너스 화면은 지금 대신 볼 수 없습니다."
                : r.status === 404
                  ? "파트너스를 찾을 수 없습니다."
                  : r.status === 403
                    ? "대신 보기는 최고관리자·운영·고객 지원 담당만 할 수 있습니다."
                    : (r.message ?? failMessage(r, "시작하지 못했습니다. 잠시 후 다시 시도해 주십시오.")),
    );
  };

  return (
    <Modal labelId="impersonate-title" busy={busy} dirty={reason !== "" || category !== ""} onClose={onClose}>
      {(requestClose) => (
        <>
          <div className="modal-h">
            <h2 className="modal-t" id="impersonate-title">
              「{seller.shopName}」 파트너스 화면을 대신 보시겠습니까?
            </h2>
            <span className="t-l2 c-alt">읽기 전용으로 봅니다 · 저장 · 결제 · 발송은 할 수 없습니다 · 사유 · 분류 · 범위 · 시간이 로그 추적에 남습니다</span>
          </div>
          <div style={{ padding: "0 24px" }}>
            <table className={`au-ft ${styles.form}`}>
              <tbody>
                <FormRow label="사유" required htmlFor="impersonate-reason" help={`1~${MAX_REASON}자 · ${count}/${MAX_REASON}`}>
                  <textarea id="impersonate-reason" className="inp" style={{ width: "100%" }} rows={3} placeholder="사유 입력" value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
                </FormRow>
                <FormRow label="분류" htmlFor="impersonate-category" help="문의 대응 · 장애 확인을 고르면 관련 건이 필수입니다">
                  <select id="impersonate-category" className="inp" style={{ width: "100%" }} value={category} onChange={(e) => { setCategory(e.target.value as Category | ""); if (e.target.value === "") setRelatedKey(""); }} disabled={busy}>
                    {CATEGORIES.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </FormRow>
                <FormRow label="관련 건" required={needsRelated} htmlFor="impersonate-related" help={category === "" ? "분류를 고르면 관련 건을 고를 수 있습니다" : related && related.length === 0 ? "이 쇼핑몰에 고를 수 있는 문의 · 알림이 없습니다" : "이 쇼핑몰의 문의 · 알림 중 하나"}>
                  <select id="impersonate-related" className="inp" style={{ width: "100%" }} value={relatedKey} onChange={(e) => setRelatedKey(e.target.value)} disabled={busy || related === null || category === ""}>
                    <option value="">{related === null ? "불러오는 중" : "관련 건 선택"}</option>
                    {(related ?? []).map((x) => (
                      <option key={`${x.kind}:${x.id}`} value={`${x.kind}:${x.id}`}>
                        {x.label}
                      </option>
                    ))}
                  </select>
                  {relatedMissing && <span className="err">관련 건을 선택해 주십시오.</span>}
                </FormRow>
                <FormRow label="범위" help="1개 이상 · 고른 범위 밖 화면은 볼 수 없습니다">
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }} role="group" aria-label="범위">
                    {SCOPES.map(([v, l]) => (
                      <button key={v} className={`chip${scopes.includes(v) ? " on" : ""}`} type="button" aria-pressed={scopes.includes(v)} onClick={() => toggleScope(v)} disabled={busy}>
                        {l}
                      </button>
                    ))}
                  </div>
                  {scopesMissing && <span className="err">범위를 1개 이상 골라 주십시오.</span>}
                </FormRow>
                <FormRow label="시간" help="60분은 최고관리자만 고를 수 있습니다 · 고르지 않으면 플랫폼 정책(MA-081)의 대신 보기 시간으로 엽니다 · 고른 값을 다시 누르면 해제됩니다">
                  <div className="seg" role="group" aria-label="시간">
                    {DURATIONS.map((m) => (
                      <button key={m} className={minutes === m ? "on" : ""} type="button" aria-pressed={minutes === m} disabled={busy || (m === 60 && !isSuper)} onClick={() => setMinutes(minutes === m ? null : m)}>
                        {m}분
                      </button>
                    ))}
                  </div>
                </FormRow>
              </tbody>
            </table>
            {error && (
              <span className="err" role="alert">
                {error}
              </span>
            )}
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={requestClose} disabled={busy}>
              취소
            </button>
            <button className="btn" type="button" onClick={() => void submit()} disabled={busy || reasonInvalid || relatedMissing || scopesMissing}>
              {busy ? "처리 중" : "대신 보기 시작"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
