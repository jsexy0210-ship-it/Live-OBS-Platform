"use client";

import { useCallback, useEffect, useState } from "react";
import { FormRow, FormSection, Modal, PageHead } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";

// SA-034 적립금 실지급 스위치(대표자만 바꿀 수 있고, 조회는 회원·적립금 권한). API: GET·PUT /api/seller/reward-live-payout.
// 기본은 꺼짐(적립은 테스트 기록으로만 남는다). 켤 때는 경고를 확인하는 창을 거쳐 confirm: true를 함께 보낸다. 끌 때는 확인이 필요 없다.
// 돈이 움직이는 설정이라 확인 체크가 있어야 「켜기」가 눌린다.

type LivePayout = { enabled: boolean; changedAt: string | null; changedByName: string | null };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; value: LivePayout };

const stamp = (iso: string) =>
  new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

export default function LivePayoutPage() {
  const { me } = useSeller();
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [confirmOn, setConfirmOn] = useState(false);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<{ livePayout: LivePayout }>("/api/seller/reward-live-payout");
    setState(r.ok ? { kind: "ok", value: r.data.livePayout } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => void load(), [load]);

  const change = async (enabled: boolean) => {
    setBusy(true);
    setFailure(null);
    const r = await api<{ livePayout: LivePayout }>("/api/seller/reward-live-payout", { method: "PUT", body: enabled ? { enabled: true, confirm: true } : { enabled: false } });
    setBusy(false);
    setConfirmOn(false);
    setAgree(false);
    if (!r.ok) return setFailure(failMessage(r, "admin", "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
    setState({ kind: "ok", value: r.data.livePayout });
    setToast(enabled ? "실지급을 켰습니다" : "실지급을 껐습니다");
  };

  const value = state.kind === "ok" ? state.value : null;

  return (
    <>
      <Topbar crumb="회원 › 적립금 실지급" />
      <main className="main">
        <PageHead title="적립금 실지급" />
        {state.kind === "loading" && (
          <div className="card">
            <LoadingRows rows={3} />
          </div>
        )}
        {state.kind === "error" && (
          <div className="card">
            {state.status === 403 ? <NoPermission need="회원·적립금" /> : state.status === 402 ? <Locked /> : <ErrorState title="실지급 설정을 불러오지 못했습니다" onRetry={() => void load()} />}
          </div>
        )}
        {value && (
          <>
            {failure && (
              <div className="msg msg-neg" role="alert" style={{ marginBottom: 16 }}>
                <span>{failure}</span>
              </div>
            )}
            {value.enabled && (
              <div className="msg msg-cau" role="note" data-testid="live-on" style={{ marginBottom: 16 }}>
                <span>
                  <b>실지급이 켜져 있습니다.</b> 새로 생기는 적립은 실제 적립금으로 지급됩니다.
                </span>
              </div>
            )}
            <FormSection title="실지급 설정">
              <FormRow label="현재 상태" help="기본은 꺼짐입니다 · 꺼져 있으면 적립은 테스트 기록으로만 남고 구매자 잔액은 바뀌지 않습니다">
                <span className={`bdg ${value.enabled ? "b-done" : "b-warn"}`} data-testid="live-status">
                  {value.enabled ? "켜짐" : "꺼짐"}
                </span>
              </FormRow>
              <FormRow label="마지막 변경" help="변경할 때마다 로그 추적에 남습니다">
                <span data-testid="live-changed">{value.changedAt ? `${stamp(value.changedAt)} · ${value.changedByName ?? "알 수 없음"}` : "변경한 적 없음"}</span>
              </FormRow>
              <FormRow label="변경" help={me.isOwner ? "대표자만 바꿀 수 있습니다" : "변경은 대표자만 할 수 있습니다"}>
                {me.isOwner ? (
                  value.enabled ? (
                    <button className="btn btn-out" type="button" disabled={busy} onClick={() => void change(false)} data-testid="live-off">
                      {busy ? "처리 중" : "실지급 끄기"}
                    </button>
                  ) : (
                    <button
                      className="btn"
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setFailure(null);
                        setAgree(false);
                        setConfirmOn(true);
                      }}
                      data-testid="live-on-button"
                    >
                      실지급 켜기
                    </button>
                  )
                ) : (
                  <span className="t-l2 c-alt">읽기 전용</span>
                )}
              </FormRow>
            </FormSection>
            <p className="help" style={{ marginTop: 16 }}>
              켜기 전에 만든 기록은 테스트 기록으로 그대로 남고 바뀌지 않습니다. 끄면 이후 생기는 적립이 다시 테스트 기록으로만 남습니다.
            </p>
          </>
        )}
      </main>

      {confirmOn && (
        <Modal labelId="live-on-title" busy={busy} onClose={() => setConfirmOn(false)}>
          <div className="modal-h">
            <h2 className="modal-t" id="live-on-title">
              적립금 실지급을 켜시겠습니까?
            </h2>
          </div>
          <div className="modal-b">
            <ul className="help" style={{ paddingLeft: 16, margin: "0 0 12px" }}>
              <li>켠 뒤 새로 생기는 적립부터 실제 적립금이 구매자에게 지급됩니다.</li>
              <li>지급된 적립금은 구매자가 쇼핑몰에서 사용할 수 있습니다.</li>
              <li>켜기 전에 만든 테스트 기록은 바뀌지 않습니다.</li>
              <li>언제든 끌 수 있고, 끈 뒤에는 새 적립이 다시 테스트 기록으로만 남습니다.</li>
            </ul>
            <label className="chk">
              <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} disabled={busy} />
              위 내용을 확인했습니다
            </label>
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" onClick={() => setConfirmOn(false)} disabled={busy}>
              취소
            </button>
            <button className="btn btn-neg" type="button" disabled={!agree || busy} onClick={() => void change(true)} data-testid="live-on-confirm">
              {busy ? "처리 중" : "켜기"}
            </button>
          </div>
        </Modal>
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
