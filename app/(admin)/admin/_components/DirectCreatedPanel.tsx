"use client";

import { useState } from "react";
import { DatePicker, FormRow, Modal, useConfirm } from "../../../../components/admin-ui";
import { daysBetween } from "../../../../lib/client/dateInput";
import { formatDateTime } from "../../../../lib/client/format";
import { textLength } from "../../../../lib/server/text/clean";
import { adminApi, failMessage } from "./api";
import type { SellerDetail } from "./partners";

// MA-012-1 상태 변형 「본인확인 대기 파트너스」(MA-017 직접 추가로 만든 쇼핑몰, 상세 응답 identityPending). 최고관리자만 변경.
// 초대 링크 재발급(POST /api/admin/sellers/{id}/invite): 이전 링크는 무효, 새 링크는 응답에서 한 번만 보인다. 체험 종료일 연장(PATCH …/trial): 새 날짜 + 사유, 시각은 지금 종료일과 같다.
// 서버 상세 응답에 발급·만료 시각 · 직접 추가한 관리자 · 사유 · 휴대폰 값이 없어 그 줄은 만들지 않는다(정본의 해당 문구는 서버 확장 뒤).
const MAX_REASON = 200;
type Invite = { path: string; url: string | null; expiresAt: string };
const kstDate = (iso: string) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" });
const dot = (iso: string) => kstDate(iso).replace(/-/g, ".");

const INVITE_STATE: Record<"active" | "used" | "revoked" | "expired", string> = { active: "아직 쓰지 않음", used: "사용함", revoked: "새 링크로 바뀌어 무효", expired: "만료됨" };

export function DirectCreatedPanel({ seller, canManage, onChanged }: { seller: { id: string; trialEndsAt: string | null; serviceEndedAt: string | null; businessInfo: Record<string, unknown> | null; directCreatedAt?: string | null; directCreation?: SellerDetail["directCreation"] }; canManage: boolean; onChanged: () => void }) {
  const { confirm } = useConfirm();
  const [invite, setInvite] = useState<(Invite & { revoked: number }) | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [extend, setExtend] = useState(false);
  // 직접 추가 표식(directCreated · representativeName)만 있고 사업자 정보가 없으면 자동 점검을 건너뛴 것이다
  const noBiz = !seller.businessInfo?.businessNumber && !seller.businessInfo?.companyName;

  const reissue = async () => {
    await confirm({
      title: "초대 링크를 다시 발급하시겠습니까?",
      body: "이전 링크는 바로 쓸 수 없게 됩니다 · 새 링크는 72시간 동안 한 번만 쓸 수 있고 이 창에서만 보여 드립니다 · 메일은 보내지 않습니다 · 로그 추적에 남습니다",
      confirmLabel: "재발급",
      run: async () => {
        const r = await adminApi<{ invite: Invite; revokedInvites: number }>(`/api/admin/sellers/${seller.id}/invite`, { method: "POST" });
        if (!r.ok) return r.message ?? failMessage(r, "다시 발급하지 못했습니다. 잠시 후 다시 시도해 주십시오.");
        setCopied(null);
        setInvite({ ...r.data.invite, revoked: r.data.revokedInvites });
      },
    });
  };
  const link = invite ? (invite.url ?? new URL(invite.path, window.location.origin).href) : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied("복사했습니다");
    } catch {
      setCopied("복사하지 못했습니다. 초대 링크를 직접 선택해 복사해 주십시오");
    }
  };

  return (
    <section className="col" style={{ gap: 12 }} aria-label="본인확인 대기" data-testid="identity-pending">
      <div className="msg msg-info" style={{ display: "block" }}>
        <b>본인확인 대기</b>
        {seller.directCreatedAt ? ` · ${dot(seller.directCreatedAt)} 최고관리자${seller.directCreation?.byAdminName ? ` ${seller.directCreation.byAdminName}` : ""}이 직접 추가` : ""}
        {seller.directCreation?.reason ? ` · 사유: ${seller.directCreation.reason}` : ""} · 대표자가 초대 링크에서 비밀번호를 정하고 본인확인을 마칠 때까지 직원 추가 · 적립금 실제 지급 · 충전금 결제 · 아이디 · 비밀번호 찾기가 막힙니다
      </div>
      <table className="au-ft">
        <tbody>
          <FormRow label="상태">
            <span className="bdg b-warn">본인확인 대기</span>
          </FormRow>
          <FormRow label="초대 링크" help={canManage ? "재발급하면 이전 링크는 쓸 수 없고 새 링크를 한 번만 보여 드립니다 · 만료 · 분실 계정을 되살리는 방법입니다" : "최고관리자만 재발급할 수 있습니다"}>
            {seller.directCreation?.invite && (
              <span>
                {formatDateTime(seller.directCreation.invite.issuedAt)} 발급 · {formatDateTime(seller.directCreation.invite.expiresAt)} 만료 · {INVITE_STATE[seller.directCreation.invite.state]}
              </span>
            )}
            {canManage && (
              <button className="btn btn-sm btn-out" type="button" onClick={() => void reissue()}>
                초대 링크 재발급
              </button>
            )}
          </FormRow>
          <FormRow label="체험 종료일" help={canManage ? (seller.serviceEndedAt ? "이용이 종료된 쇼핑몰은 연장할 수 없습니다" : "최고관리자만 · 사유 필수 · 상한 없음") : "최고관리자만 연장할 수 있습니다"}>
            <span>{seller.trialEndsAt ? dot(seller.trialEndsAt) : "—"}</span>
            {canManage && seller.trialEndsAt && !seller.serviceEndedAt && (
              <button className="btn btn-sm btn-out" type="button" onClick={() => setExtend(true)}>
                연장
              </button>
            )}
          </FormRow>
          {noBiz && (
            <FormRow label="사업자 자동 점검" help="사업자 정보 없음 · 파트너스가 입력하면 점검합니다">
              <span className="bdg b-gray">자동 점검 건너뜀</span>
            </FormRow>
          )}
        </tbody>
      </table>
      {invite && (
        <div style={{ padding: 12, border: "1px solid var(--cs-line)" }} data-testid="reissued-invite">
          <p className="t-c1 c-alt" style={{ margin: "0 0 8px" }}>
            새 초대 링크 · 이 창을 닫으면 다시 볼 수 없습니다
          </p>
          <div className="row" style={{ gap: 8, alignItems: "center" }}>
            <span style={{ overflowWrap: "anywhere", minWidth: 0, flex: 1, userSelect: "all" }} data-testid="reissued-invite-link">
              {link}
            </span>
            <button className="btn btn-sm btn-out" type="button" onClick={() => void copy()}>
              복사
            </button>
          </div>
          <p className="t-c1 c-alt" style={{ margin: "8px 0 0" }}>
            {formatDateTime(invite.expiresAt)} KST 만료 · 이전 링크 {invite.revoked}개 무효 · 대표자에게 직접 전달해 주십시오
          </p>
          {copied && <span role="status">{copied}</span>}
        </div>
      )}
      {extend && seller.trialEndsAt && (
        <ExtendTrialDialog
          sellerId={seller.id}
          current={seller.trialEndsAt}
          onClose={() => setExtend(false)}
          onDone={() => {
            setExtend(false);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

function ExtendTrialDialog({ sellerId, current, onClose, onDone }: { sellerId: string; current: string; onClose: () => void; onDone: () => void }) {
  const [date, setDate] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = textLength(reason);
  const currentDate = kstDate(current);
  // 새 날짜의 시각은 지금 종료일과 같게 둔다(한국 표준시는 일광 절약이 없어 일수만큼 더하면 된다). 이미 지난 종료일을 오늘로 연장하면 그 시각이 지났을 수 있어 만든 시각으로 검사한다.
  const next = date && date > currentDate ? new Date(new Date(current).getTime() + daysBetween(currentDate, date) * 86_400_000) : null;
  const past = !!next && next.getTime() <= Date.now();
  const invalid = !next || past || count === 0 || count > MAX_REASON;

  const submit = async () => {
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    const r = await adminApi<{ trialEndsAt: string }>(`/api/admin/sellers/${sellerId}/trial`, { method: "PATCH", json: { trialEndsAt: next!.toISOString(), reason: reason.trim() } });
    setBusy(false);
    if (r.ok) return onDone();
    setError(r.message ?? failMessage(r, "연장하지 못했습니다. 잠시 후 다시 시도해 주십시오."));
  };

  return (
    <Modal labelId="trial-extend-title" busy={busy} dirty={date !== "" || reason !== ""} onClose={onClose}>
      {(requestClose) => (
        <>
          <div className="modal-h">
            <h2 className="modal-t" id="trial-extend-title">
              체험 종료일을 연장하시겠습니까?
            </h2>
          </div>
          <div style={{ padding: "0 24px" }}>
            <table className="au-ft">
              <tbody>
                <FormRow label="지금 종료일">
                  <span>{dot(current)}</span>
                </FormRow>
                <FormRow label="새 종료일" required help="지금 종료일 이후 · 상한 없음">
                  <DatePicker aria-label="새 종료일" value={date} onChange={setDate} />
                  {past && <span className="err">선택한 날짜의 종료 시각이 이미 지났습니다 · 더 뒤 날짜를 골라 주십시오</span>}
                </FormRow>
                <FormRow label="사유" required htmlFor="trial-reason" help={`1~${MAX_REASON}자 · 로그 추적에 남습니다`}>
                  <textarea id="trial-reason" className="inp" style={{ width: "100%" }} rows={2} placeholder="사유 입력" value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />
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
            <button className="btn" type="button" onClick={() => void submit()} disabled={busy || invalid}>
              {busy ? "처리 중" : "연장"}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
