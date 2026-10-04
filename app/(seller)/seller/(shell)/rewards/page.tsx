"use client";

import { useCallback, useEffect, useState } from "react";
import { FormFoot, FormRow, FormSection, PageHead } from "../../../../../components/admin-ui";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";

// SA-031 적립 정책 중 「적립금 지급 시점」만(API: GET·PUT /api/seller/reward-policy, 회원·적립금 권한).
// 등급별 적립률·회수 모드·사용 조건·원장·실지급 스위치는 API가 생기면 붙인다.

type EarnTiming = "ON_PAYMENT" | "ON_DELIVERY";
const OPTIONS: { key: EarnTiming; title: string; desc: string }[] = [
  { key: "ON_PAYMENT", title: "결제하면 바로 지급", desc: "결제 완료와 함께 적립됩니다 · 취소 · 환불하면 지급한 적립금을 회수합니다" },
  { key: "ON_DELIVERY", title: "배송 완료 후 지급 (기본)", desc: "배송이 완료된 뒤 적립됩니다 · 그 전에 취소 · 환불된 주문은 지급되지 않습니다" },
];

export default function RewardPolicyPage() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; saved: EarnTiming }>({ kind: "loading" });
  const [timing, setTiming] = useState<EarnTiming>("ON_DELIVERY");
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<{ policy: { earnTiming: EarnTiming } }>("/api/seller/reward-policy");
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setTiming(r.data.policy.earnTiming);
    setState({ kind: "ok", saved: r.data.policy.earnTiming });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const saved = state.kind === "ok" ? state.saved : null;
  const dirty = saved !== null && saved !== timing;

  const save = async () => {
    if (!dirty) return;
    setSaving(true);
    setFailure(null);
    const r = await api<{ policy: { earnTiming: EarnTiming } }>("/api/seller/reward-policy", { method: "PUT", body: { earnTiming: timing } });
    setSaving(false);
    if (!r.ok) return setFailure(failMessage(r, "admin", "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
    setTiming(r.data.policy.earnTiming);
    setState({ kind: "ok", saved: r.data.policy.earnTiming });
    setToast("적립금 지급 시점을 저장했습니다 · 다음 결제부터 적용됩니다");
  };

  const option = OPTIONS.find((o) => o.key === timing)!;

  return (
    <>
      <Topbar crumb="판매 › 적립금" />
      <main className="main">
        <PageHead title="적립 정책" />

        {state.kind !== "ok" ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={3} />}
            {state.kind === "error" &&
              (state.status === 403 ? (
                <NoPermission need="회원·적립금" />
              ) : state.status === 402 ? (
                <Locked />
              ) : (
                <ErrorState title="적립 정책을 불러오지 못했습니다" onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <fieldset className="settings-fields" disabled={saving}>
              {failure && (
                <div className="msg msg-neg" role="alert" style={{ marginBottom: 16 }}>
                  <span>
                    <b>저장할 수 없습니다.</b> {failure}
                  </span>
                </div>
              )}
              <FormSection title="적립금 지급 시점">
                <FormRow label="지급 시점" help={option.desc}>
                  <div className="row" role="radiogroup" aria-label="적립금 지급 시점" style={{ gap: 24, flexWrap: "wrap" }}>
                    {OPTIONS.map((o) => (
                      <label key={o.key} className="chk">
                        <input className="rdo" type="radio" name="earn-timing" checked={timing === o.key} onChange={() => setTiming(o.key)} aria-label={o.title} />
                        {o.title}
                      </label>
                    ))}
                  </div>
                </FormRow>
              </FormSection>
              <div className="msg msg-info t-l2" role="note" style={{ marginTop: 16 }}>
                <span>
                  <b>적립금은 결제할 때 금액으로 정해집니다.</b> 지급 시점을 변경해도 적립 금액은 그대로이고, 적립되는 시점만 달라집니다.
                </span>
              </div>
              <p className="help" style={{ marginTop: 8 }}>
                변경한 지급 시점은 저장한 뒤 결제되는 주문부터 적용됩니다. 이미 결제한 주문은 결제할 때의 설정을 따릅니다.
              </p>
            </fieldset>
            <FormFoot>
              <button className="btn btn-lg" type="submit" disabled={saving || !dirty}>
                {saving ? "저장 중" : "저장"}
              </button>
            </FormFoot>
          </form>
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
