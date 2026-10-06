"use client";

import { useCallback, useEffect, useState } from "react";
import { FormRow, FormSection, PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { formatDateTime } from "../../../../../../lib/client/format";

// SA-034 적립금 실제 지급 스위치(대표자만 바꿀 수 있고, 조회는 회원·적립금 권한). API: GET·PUT /api/seller/reward-live-payout.
// 기본은 꺼짐(적립은 「계산만」 기록으로 남는다). 켜기·끄기 모두 공용 확인 창을 거친다(켤 때는 confirm: true를 함께 보낸다).

type LivePayout = { enabled: boolean; changedAt: string | null; changedByName: string | null };
type Load = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; value: LivePayout };

export default function LivePayoutPage() {
  const { me } = useSeller();
  const [state, setState] = useState<Load>({ kind: "loading" });
  const { confirm } = useConfirm();
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<{ livePayout: LivePayout }>("/api/seller/reward-live-payout");
    setState(r.ok ? { kind: "ok", value: r.data.livePayout } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => void load(), [load]);

  const change = async (enabled: boolean) => {
    setFailure(null);
    let next: LivePayout | undefined;
    const ok = await confirm({
      title: enabled ? "적립금을 실제로 지급하도록 켜시겠습니까?" : "적립금 실제 지급을 끄시겠습니까?",
      body: enabled
        ? "켠 뒤 새로 생기는 적립부터 실제 적립금이 구매자에게 지급되고, 구매자가 쇼핑몰에서 바로 사용할 수 있습니다. 이 작업은 로그 추적에 남습니다. 언제든 끌 수 있습니다."
        : "끄면 이후 생기는 적립은 다시 「계산만」 기록으로 남습니다. 이미 지급한 적립금은 그대로입니다.",
      confirmLabel: enabled ? "실제 지급 켜기" : "실제 지급 끄기",
      danger: enabled,
      run: async () => {
        const r = await api<{ livePayout: LivePayout }>("/api/seller/reward-live-payout", { method: "PUT", body: enabled ? { enabled: true, confirm: true } : { enabled: false } });
        if (!r.ok) return failMessage(r, "admin", "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오");
        next = r.data.livePayout;
      },
    });
    if (!ok || !next) return;
    setState({ kind: "ok", value: next });
    setToast(enabled ? "실제 지급을 켰습니다" : "실제 지급을 껐습니다");
  };

  const value = state.kind === "ok" ? state.value : null;

  return (
    <>
      <Topbar crumb="고객 › 적립금 › 실제 지급 켜기" />
      <main className="main">
        <PageHead title="실제 지급 켜기" />
        {state.kind === "loading" && (
          <div className="card">
            <LoadingRows rows={3} />
          </div>
        )}
        {state.kind === "error" && (
          <div className="card">
            {state.status === 403 ? <NoPermission need="회원·적립금" /> : state.status === 402 ? <Locked /> : <ErrorState title="실제 지급 설정을 불러오지 못했습니다" onRetry={() => void load()} />}
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
                  <b>실제 지급이 켜져 있습니다.</b> 새로 생기는 적립은 실제 적립금으로 지급됩니다.
                </span>
              </div>
            )}
            <FormSection title="실제 지급 설정">
              <FormRow label="현재 상태" help="기본은 꺼짐입니다 · 꺼져 있으면 적립은 「계산만」 기록으로 남고 구매자 잔액은 바뀌지 않습니다">
                <span className={`bdg ${value.enabled ? "b-done" : "b-warn"}`} data-testid="live-status">
                  {value.enabled ? "켜짐" : "꺼짐"}
                </span>
              </FormRow>
              <FormRow label="마지막 변경" help="변경할 때마다 로그 추적에 남습니다">
                <span data-testid="live-changed">{value.changedAt ? `${formatDateTime(value.changedAt)} · ${value.changedByName ?? "알 수 없음"}` : "변경한 적 없음"}</span>
              </FormRow>
              <FormRow label="변경" help={me.isOwner ? "대표자만 바꿀 수 있습니다" : "변경은 대표자만 할 수 있습니다"}>
                {me.isOwner ? (
                  value.enabled ? (
                    <button className="btn btn-out" type="button" onClick={() => void change(false)} data-testid="live-off">
                      실제 지급 끄기
                    </button>
                  ) : (
                    <button className="btn" type="button" onClick={() => void change(true)} data-testid="live-on-button">
                      실제 지급 켜기
                    </button>
                  )
                ) : (
                  <span className="t-l2 c-alt">읽기 전용</span>
                )}
              </FormRow>
            </FormSection>
            <p className="help" style={{ marginTop: 16 }}>
              켜기 전에 만든 「계산만」 기록은 그대로 남고 바뀌지 않습니다. 끄면 이후 생기는 적립이 다시 「계산만」 기록으로 남습니다.
            </p>
          </>
        )}
      </main>

      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
