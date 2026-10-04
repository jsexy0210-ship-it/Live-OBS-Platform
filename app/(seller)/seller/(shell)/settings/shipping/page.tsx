"use client";

import { useCallback, useEffect, useState } from "react";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { SettingsTabs } from "../../../../../../components/seller/SettingsTabs";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { parseAmount, won } from "../../../../../../components/seller/format";

// SA-061 배송비 정책. 지금 API가 받는 항목(배송비 방식·배송비·무료 기준·제주·도서산간 추가 배송비·반품·교환 배송비)만 보여 준다.
// 받는 방법·발송 기간·기본 택배사, 제주와 그 밖의 도서지역을 나눈 금액은 API가 생기면 붙인다.

type Policy = {
  freeShipping: boolean;
  baseFee: number;
  freeOverAmount: number | null;
  remoteSurcharge: number;
  remoteZipRanges: [number, number][];
  returnFee: number; // 반품 배송비(편도)
  exchangeFee: number; // 교환 배송비(왕복)
};
type Mode = "free" | "fixed" | "threshold";

const MAX_FEE = 100_000;
const MAX_FREE_OVER = 100_000_000;
const MODES: { key: Mode; title: string; desc: string }[] = [
  { key: "free", title: "무료", desc: "모든 주문 배송비 0원 · 제주 · 도서산간 추가는 따로 붙습니다" },
  { key: "fixed", title: "고정", desc: "금액과 상관없이 정한 배송비를 받습니다" },
  { key: "threshold", title: "일정 금액 이상 무료", desc: "기준 금액보다 적게 사면 배송비를 받고, 넘으면 0원입니다" },
];

// 무료는 freeShipping 플래그로 저장한다(#84). 배송비·무료 기준은 그대로 남겨 두어 다른 방식으로 되돌리면 이전 값이 다시 보인다.
const modeOf = (p: Policy): Mode => (p.freeShipping ? "free" : p.freeOverAmount === null ? "fixed" : "threshold");

function feeError(v: string, max: number, min = 0): string | null {
  if (v.trim() === "") return "금액을 입력해 주십시오";
  const n = parseAmount(v);
  if (n === null) return "숫자만 입력해 주십시오";
  if (n < min) return `${min.toLocaleString("ko-KR")}원 이상으로 입력해 주십시오`;
  if (n > max) return `${won(max)}까지 정할 수 있습니다`;
  return null;
}

export default function ShippingSettingsPage() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; saved: Policy }>({ kind: "loading" });
  const [mode, setMode] = useState<Mode>("fixed");
  const [fee, setFee] = useState("");
  const [freeOver, setFreeOver] = useState("");
  const [remote, setRemote] = useState("");
  const [returnFee, setReturnFee] = useState("");
  const [exchangeFee, setExchangeFee] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const apply = (p: Policy) => {
    setMode(modeOf(p));
    setFee(String(p.baseFee));
    setFreeOver(p.freeOverAmount === null ? "" : String(p.freeOverAmount));
    setRemote(String(p.remoteSurcharge));
    setReturnFee(String(p.returnFee));
    setExchangeFee(String(p.exchangeFee));
  };

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<{ policy: Policy }>("/api/seller/shipping-policy");
    if (!r.ok) return setState({ kind: "error", status: r.status });
    apply(r.data.policy);
    setState({ kind: "ok", saved: r.data.policy });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const errors = {
    fee: mode === "free" ? null : feeError(fee, MAX_FEE, 1),
    freeOver: mode === "threshold" ? (freeOver.trim() === "" ? "무료 배송 기준 금액을 입력해 주십시오" : feeError(freeOver, MAX_FREE_OVER, 1)) : null,
    remote: feeError(remote, MAX_FEE),
    returnFee: feeError(returnFee, MAX_FEE),
    exchangeFee: feeError(exchangeFee, MAX_FEE),
  };
  const valid = !errors.fee && !errors.freeOver && !errors.remote && !errors.returnFee && !errors.exchangeFee;
  const saved = state.kind === "ok" ? state.saved : null;

  const next = (): Policy | null =>
    !saved || !valid
      ? null
      : {
          freeShipping: mode === "free",
          // 무료일 때는 칸에 남은 값이 올바르면 그 값, 아니면 저장된 값을 그대로 보낸다
          baseFee: mode !== "free" ? parseAmount(fee)! : feeError(fee, MAX_FEE) ? saved.baseFee : parseAmount(fee)!,
          freeOverAmount:
            mode === "threshold"
              ? parseAmount(freeOver)!
              : mode === "free"
                ? freeOver.trim() === "" || feeError(freeOver, MAX_FREE_OVER, 1)
                  ? saved.freeOverAmount
                  : parseAmount(freeOver)!
                : null,
          remoteSurcharge: parseAmount(remote)!,
          // 도서산간 우편번호 구간은 이 화면에서 바꾸지 않고 저장된 값을 그대로 보낸다
          remoteZipRanges: saved.remoteZipRanges,
          returnFee: parseAmount(returnFee)!,
          exchangeFee: parseAmount(exchangeFee)!,
        };
  const candidate = next();
  const dirty =
    !!saved &&
    (!candidate ||
      candidate.freeShipping !== saved.freeShipping ||
      candidate.baseFee !== saved.baseFee ||
      candidate.freeOverAmount !== saved.freeOverAmount ||
      candidate.remoteSurcharge !== saved.remoteSurcharge ||
      candidate.returnFee !== saved.returnFee ||
      candidate.exchangeFee !== saved.exchangeFee);

  const save = async () => {
    if (!candidate) {
      setShowErrors(true);
      return;
    }
    setSaving(true);
    setFailure(null);
    const r = await api<{ policy: Policy }>("/api/seller/shipping-policy", { method: "PUT", body: candidate });
    setSaving(false);
    if (!r.ok) return setFailure(failMessage(r, "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
    apply(r.data.policy);
    setState({ kind: "ok", saved: r.data.policy });
    setShowErrors(false);
    setToast("배송비 정책을 저장했습니다 · 다음 주문부터 적용됩니다");
  };

  const shown = showErrors ? errors : { fee: null, freeOver: null, remote: null, returnFee: null, exchangeFee: null };
  const returnNum = parseAmount(returnFee);
  const exchangeNum = parseAmount(exchangeFee);
  const feeNum = parseAmount(fee);
  const overNum = parseAmount(freeOver);
  const remoteNum = parseAmount(remote);
  const summary =
    mode === "free"
      ? "배송비 무료"
      : mode === "fixed"
        ? feeNum !== null && !errors.fee
          ? `배송비 ${won(feeNum)}`
          : null
        : feeNum !== null && overNum !== null && !errors.fee && !errors.freeOver
          ? `배송비 ${won(feeNum)} · ${won(overNum)} 이상 무료`
          : null;

  // 금액 칸: 단위 「원」은 칸 안 오른쪽에 붙인다
  const amountInput = (id: string, label: string, value: string, set: (v: string) => void, err: string | null, help?: string) => (
    <div className="fld">
      <label htmlFor={id}>{label}</label>
      <div style={{ position: "relative" }}>
        <input
          id={id}
          className={`inp num${err ? " is-error" : ""}`}
          type="text"
          inputMode="numeric"
          value={value}
          onChange={(e) => set(e.target.value)}
          style={{ textAlign: "right", paddingRight: 36 }}
          aria-invalid={!!err}
        />
        <span className="t-l2 c-alt amount-unit" aria-hidden="true">
          원
        </span>
      </div>
      {err ? <span className="err">{err}</span> : help ? <span className="help">{help}</span> : null}
    </div>
  );

  return (
    <>
      <Topbar crumb="설정 › 쇼핑몰 설정 › 배송비 정책">
        {saved && (
          <button className="btn btn-sm" type="button" onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? "저장 중" : "저장"}
          </button>
        )}
      </Topbar>
      <main className="main">
        <SettingsTabs />
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">배송비 정책</h1>
            <span className="t-l2 c-alt">주문서의 배송비가 이 설정대로 표시됩니다. 저장하면 다음 주문부터 적용됩니다.</span>
          </div>
        </div>

        {state.kind !== "ok" ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={5} />}
            {state.kind === "error" &&
              (state.status === 403 ? (
                <NoPermission need="쇼핑몰 설정" />
              ) : state.status === 402 ? (
                <Locked />
              ) : (
                <ErrorState title="배송비 정책을 불러오지 못했습니다" onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <div className="form-grid">
            <div className="col" style={{ gap: 20 }}>
              {failure && (
                <div className="msg msg-neg" role="alert">
                  <span>
                    <b>저장할 수 없습니다.</b> {failure}
                  </span>
                </div>
              )}
              <section className="card pad col" style={{ gap: 12 }} role="radiogroup" aria-label="배송비 방식">
                <h2 className="t-hl2">배송비 방식</h2>
                {MODES.map((m) => (
                  <div key={m.key} className={`col choice${mode === m.key ? " on" : ""}`} style={{ gap: 10 }}>
                    <label className="row" style={{ gap: 10, cursor: "pointer" }}>
                      <input className="rdo" type="radio" name="fee-mode" checked={mode === m.key} onChange={() => setMode(m.key)} aria-label={m.title} />
                      <span className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                        <span className="t-l1 fw6">{m.title}</span>
                        <span className="t-c1 c-alt">{m.desc}</span>
                      </span>
                    </label>
                    {mode === m.key && m.key !== "free" && (
                      <div className="g3" style={{ paddingLeft: 30 }}>
                        {amountInput("fee", "배송비", fee, setFee, shown.fee)}
                        {m.key === "threshold" && amountInput("free-over", "무료 배송 기준", freeOver, setFreeOver, shown.freeOver, "이상 주문이면 배송비 0원")}
                      </div>
                    )}
                  </div>
                ))}
              </section>

              <section className="card pad col" style={{ gap: 14 }}>
                <h2 className="t-hl2">제주·도서산간 추가 배송비</h2>
                <span className="t-c1 c-alt">
                  <b>무료 배송이어도 붙습니다.</b> 우편번호로 자동 판별합니다. 주문서와 주문 완료 화면에 「도서산간 추가」 줄로 따로 표시됩니다.
                </span>
                <div className="g3">{amountInput("remote", "제주·도서산간 추가 배송비", remote, setRemote, shown.remote, "기본 3,000원 · 제주와 그 밖의 도서지역에 같은 금액이 붙습니다")}</div>
              </section>

              <section className="card pad col" style={{ gap: 14 }}>
                <h2 className="t-hl2">반품 · 교환 배송비</h2>
                <div className="g3">
                  {amountInput("return-fee", "반품 배송비 (편도)", returnFee, setReturnFee, shown.returnFee, "기본 3,000원")}
                  {amountInput("exchange-fee", "교환 배송비 (왕복)", exchangeFee, setExchangeFee, shown.exchangeFee, "기본 6,000원 · 교환 접수가 열리면 적용됩니다")}
                </div>
                <div className="msg msg-info t-l2" role="note">
                  <span>
                    단순 변심일 때만 받습니다. 상품 불량 · 오배송은 파트너스가 부담합니다. 반품하면 처음 낸 배송비는 돌려주지 않고 반품 배송비를 빼고 환불합니다.{" "}
                    {/* 서버는 주문의 배송비가 0원일 때만 두 배로 뺀다(도서산간 추가비가 붙으면 0원이 아님, queue/service computeRefund) */}
                    <b>무료 배송 주문(배송비 0원)은 반품 배송비 × 2를 뺍니다.</b> 도서산간 추가 배송비를 낸 주문은 한 번만 뺍니다. 교환 배송비는 교환 접수가 열리면 적용됩니다.
                  </span>
                </div>
              </section>
            </div>

            <aside className="col aside-sticky" style={{ gap: 16 }}>
              <div className="card pad col" style={{ gap: 10 }}>
                <span className="t-hl2">주문서 미리보기</span>
                <div className="col" style={{ gap: 6, padding: 12, borderRadius: 10, background: "var(--wds-fill-alternative)" }}>
                  <div className="row between t-l2" style={{ gap: 12 }}>
                    <span className="c-alt">배송</span>
                    <span className="num" data-testid="fee-preview" style={{ textAlign: "right" }}>
                      {summary ?? "금액을 입력하면 여기에 표시됩니다"}
                    </span>
                  </div>
                  <div className="row between t-l2" style={{ gap: 12 }}>
                    <span className="c-alt">도서산간 추가</span>
                    <span className="num c-alt">{remoteNum !== null && !errors.remote ? (remoteNum === 0 ? "받지 않음" : `+${won(remoteNum)} · 해당 주소만`) : "—"}</span>
                  </div>
                </div>
                <span className="t-l2" data-testid="return-preview">
                  반품 · 교환 안내: 「
                  {returnNum !== null && exchangeNum !== null && !errors.returnFee && !errors.exchangeFee
                    ? `단순 변심 반품 배송비 ${won(returnNum)} · 교환 ${won(exchangeNum)}`
                    : "금액을 입력하면 여기에 표시됩니다"}
                  」
                </span>
              </div>
              <div className="card pad col" style={{ gap: 6 }}>
                <span className="t-hl2">참고</span>
                <span className="t-l2 c-neu">배송비는 결제 금액에 합산됩니다. 발송 전에 환불하면 배송비까지 모두 돌려줍니다. 발송 뒤 상품 불량 · 오배송이면 상품값과 처음 낸 배송비를 돌려주고, 단순 변심이면 반품 배송비를 빼고 돌려줍니다. 이미 받은 주문의 배송비는 바뀌지 않습니다.</span>
              </div>
              <button className="btn btn-lg btn-block" type="button" onClick={() => void save()} disabled={saving || !dirty}>
                {saving ? "저장 중" : "저장"}
              </button>
            </aside>
          </div>
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
