"use client";

import { useCallback, useEffect, useState } from "react";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";

// SA-031 적립 정책 중 「적립금 지급 시점」만(API: GET·PUT /api/seller/reward-policy, 회원·적립금 권한).
// 등급별 적립률·회수 모드·사용 조건·원장·실지급 스위치는 API가 생기면 붙인다.

type EarnTiming = "ON_PAYMENT" | "ON_DELIVERY";
const OPTIONS: { key: EarnTiming; title: string; desc: string }[] = [
  { key: "ON_PAYMENT", title: "결제하면 바로 지급", desc: "결제 완료와 함께 쌓여요 · 취소 · 환불하면 지급한 적립금을 다시 가져와요" },
  { key: "ON_DELIVERY", title: "배송 완료 후 지급 (기본)", desc: "배송이 완료된 뒤 쌓여요 · 그 전에 취소 · 환불된 주문은 지급되지 않아요" },
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
    if (!r.ok) return setFailure(failMessage(r, "저장하지 못했어요. 잠시 뒤 다시 시도해 주세요"));
    setTiming(r.data.policy.earnTiming);
    setState({ kind: "ok", saved: r.data.policy.earnTiming });
    setToast("적립금 지급 시점을 저장했어요 · 다음 결제부터 적용돼요");
  };

  return (
    <>
      <Topbar crumb="판매 › 적립금">
        {saved && (
          <button className="btn btn-sm" type="button" onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? "저장하고 있어요" : "저장"}
          </button>
        )}
      </Topbar>
      <main className="main">
        <nav className="tabs" aria-label="적립금">
          <a className="tab on" href="/seller/rewards" aria-current="page">
            적립 정책
          </a>
        </nav>
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">적립 정책</h1>
            <span className="t-l2 c-alt">구매자 적립금을 언제 쌓을지 정해요. 저장하면 다음 결제부터 적용돼요.</span>
          </div>
        </div>

        {state.kind !== "ok" ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={3} />}
            {state.kind === "error" &&
              (state.status === 403 ? (
                <NoPermission need="회원·적립금" />
              ) : state.status === 402 ? (
                <Locked />
              ) : (
                <ErrorState title="적립 정책을 불러오지 못했어요" onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <div className="form-grid">
            <div className="col" style={{ gap: 20 }}>
              {failure && (
                <div className="msg msg-neg" role="alert">
                  <span>
                    <b>저장할 수 없어요.</b> {failure}
                  </span>
                </div>
              )}
              <section className="card pad-l col" style={{ gap: 14 }} role="radiogroup" aria-label="적립금 지급 시점">
                <h2 className="t-hl1">적립금 지급 시점</h2>
                <div className="col" style={{ gap: 8 }}>
                  {OPTIONS.map((o) => (
                    <label key={o.key} className={`row choice${timing === o.key ? " on" : ""}`} style={{ gap: 10 }}>
                      <input className="rdo" type="radio" name="earn-timing" checked={timing === o.key} onChange={() => setTiming(o.key)} aria-label={o.title} />
                      <span className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                        <span className="t-l1 fw6">{o.title}</span>
                        <span className="t-c1 c-alt">{o.desc}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <div className="msg msg-info t-l2" role="note">
                  <span>
                    <b>적립금은 결제할 때 금액으로 정해져요.</b> 지급 시점을 바꿔도 적립 금액은 그대로이고, 언제 쌓이는지만 달라져요.
                  </span>
                </div>
              </section>
            </div>

            <aside className="col aside-sticky" style={{ gap: 16 }}>
              <div className="card pad col" style={{ gap: 6 }}>
                <span className="t-hl2">알아 두세요</span>
                <span className="t-l2 c-neu">바꾼 지급 시점은 저장한 뒤 결제되는 주문부터 적용돼요. 이미 결제한 주문은 결제할 때의 설정을 따라요.</span>
              </div>
              <button className="btn btn-lg btn-block" type="button" onClick={() => void save()} disabled={saving || !dirty}>
                {saving ? "저장하고 있어요" : "저장"}
              </button>
            </aside>
          </div>
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
