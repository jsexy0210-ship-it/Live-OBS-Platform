"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FormFoot, FormRow, FormSection, PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { parseAmount, won } from "../../../../../../components/seller/format";
import { useUnsavedGuard } from "../../../../../../lib/client/navigation";

// SA-061 배송 설정(주문 · 배송 설정 › 배송비 정책 탭). API가 받는 항목: 배송비 방식·배송비·무료 기준·제주·도서산간 추가 배송비·반품·교환 배송비,
// 받는 방법(지금은 「바로 받기」만, 「보관 후 받기」는 준비 중)·발송 기한(1~30일)·기본 택배사(선택).
// 제주와 그 밖의 도서지역을 나눈 금액은 API가 생기면 붙인다.

type Policy = {
  freeShipping: boolean;
  baseFee: number;
  freeOverAmount: number | null;
  remoteSurcharge: number;
  remoteZipRanges: [number, number][];
  returnFee: number; // 반품 배송비(편도)
  exchangeFee: number; // 교환 배송비(왕복)
  receiveMethods: string[];
  dispatchDeadlineDays: number;
  defaultCourier: string | null;
};
type Extras = { couriers: Record<string, string>; maxDays: number; planned: string[] };
const METHOD_LABEL: Record<string, string> = { IMMEDIATE: "바로 받기", STORAGE: "보관하기 · 합배송" };
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

function deadlineError(v: string, max: number): string | null {
  if (v.trim() === "") return "발송까지 걸리는 기간을 적어 주십시오";
  const n = parseAmount(v);
  if (n === null) return "숫자만 입력해 주십시오";
  return n < 1 || n > max ? `1일에서 ${max}일 사이로 입력해 주십시오` : null;
}

export default function ShippingSettingsPage() {
  const { confirm } = useConfirm();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; saved: Policy }>({ kind: "loading" });
  const [mode, setMode] = useState<Mode>("fixed");
  const [fee, setFee] = useState("");
  const [freeOver, setFreeOver] = useState("");
  const [remote, setRemote] = useState("");
  const [returnFee, setReturnFee] = useState("");
  const [exchangeFee, setExchangeFee] = useState("");
  const [deadline, setDeadline] = useState("");
  const [courier, setCourier] = useState("");
  const [extras, setExtras] = useState<Extras>({ couriers: {}, maxDays: 30, planned: [] });
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
    setDeadline(String(p.dispatchDeadlineDays));
    setCourier(p.defaultCourier ?? "");
  };

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<{ policy: Policy; couriers: Record<string, string>; receiveMethodOptions: { planned: string[] }; maxDispatchDeadlineDays: number }>("/api/seller/shipping-policy");
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setExtras({ couriers: r.data.couriers, maxDays: r.data.maxDispatchDeadlineDays, planned: r.data.receiveMethodOptions.planned });
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
    deadline: deadlineError(deadline, extras.maxDays),
  };
  const valid = !errors.fee && !errors.freeOver && !errors.remote && !errors.returnFee && !errors.exchangeFee && !errors.deadline;
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
          // 받는 방법은 지금 「바로 받기」만 고를 수 있어 저장된 값을 그대로 보낸다
          receiveMethods: saved.receiveMethods,
          dispatchDeadlineDays: parseAmount(deadline)!,
          defaultCourier: courier === "" ? null : courier,
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
      candidate.exchangeFee !== saved.exchangeFee ||
      candidate.dispatchDeadlineDays !== saved.dispatchDeadlineDays ||
      candidate.defaultCourier !== saved.defaultCourier);
  useUnsavedGuard(dirty); // 링크·브라우저 Back·새로고침에 같은 확인(docs/IA.md Back 규칙 7항)

  const save = async () => {
    if (!candidate) {
      setShowErrors(true);
      return;
    }
    if (!(await confirm({ title: "배송 설정을 저장하시겠습니까?", body: "바뀐 배송비 · 받는 방법은 저장한 뒤 들어오는 주문부터 적용됩니다. 이미 접수된 주문의 배송비는 바뀌지 않습니다.", confirmLabel: "저장" }))) return;
    setSaving(true);
    setFailure(null);
    const r = await api<{ policy: Policy }>("/api/seller/shipping-policy", { method: "PUT", body: candidate });
    setSaving(false);
    if (!r.ok) return setFailure(failMessage(r, "admin", "저장하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 눌러 주십시오"));
    apply(r.data.policy);
    setState({ kind: "ok", saved: r.data.policy });
    setShowErrors(false);
    setToast("배송 설정을 저장했습니다 · 다음 주문부터");
  };

  const shown = showErrors ? errors : { fee: null, freeOver: null, remote: null, returnFee: null, exchangeFee: null, deadline: null };
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

  // 금액 칸: 값은 왼쪽 정렬, 단위 「원」은 칸 오른쪽에 붙인다
  const amountInput = (id: string, value: string, set: (v: string) => void, err: string | null) => (
    <>
      <input
        id={id}
        className={`inp num${err ? " is-error" : ""}`}
        type="text"
        inputMode="numeric"
        value={value}
        onChange={(e) => set(e.target.value)}
        style={{ width: 160 }}
        aria-invalid={!!err}
      />
      <span className="t-l2 c-alt">원</span>
      {err && <span className="err">{err}</span>}
    </>
  );
  const modeInfo = MODES.find((m) => m.key === mode)!;

  return (
    <>
      <Topbar crumb="설정 › 주문 · 배송 설정 › 배송 설정" />
      <main className="main">
        <PageHead description="배송비와 반품·교환 비용, 발송 안내를 설정합니다." title="배송 설정" />

        {state.kind !== "ok" ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={5} />}
            {state.kind === "error" &&
              (state.status === 403 ? (
                <NoPermission need="쇼핑몰 설정" />
              ) : state.status === 402 ? (
                <Locked />
              ) : (
                <ErrorState title="배송 설정을 불러오지 못했습니다" onRetry={() => void load()} />
              ))}
          </div>
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            {/* 저장하는 동안은 칸을 잠근다: 보낸 값과 다른 수정이 응답으로 덮이지 않게 */}
            <fieldset className="settings-fields" disabled={saving}>
              {failure && (
                <div className="msg msg-neg" role="alert" style={{ marginBottom: 16 }}>
                  <span>
                    <b>저장할 수 없습니다.</b> {failure}
                  </span>
                </div>
              )}
              <FormSection title="배송비">
                <FormRow label="배송비 방식" required>
                  <div role="radiogroup" aria-label="배송비 방식" style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
                    {MODES.map((m) => (
                      <div key={m.key}>
                        <label className="chk">
                          <input className="rdo" type="radio" name="fee-mode" checked={mode === m.key} onChange={() => setMode(m.key)} aria-label={m.title} />
                          {m.title}
                        </label>
                        <p className="help">{m.desc}</p>
                      </div>
                    ))}
                  </div>
                </FormRow>
                {mode !== "free" && (
                  <FormRow label="배송비" required htmlFor="fee" help="고정 · 일정 금액 이상 무료에서 받는 금액">
                    {amountInput("fee", fee, setFee, shown.fee)}
                  </FormRow>
                )}
                {mode === "threshold" && (
                  <FormRow label="무료 배송 기준" required htmlFor="free-over">
                    {amountInput("free-over", freeOver, setFreeOver, shown.freeOver)}
                    <span className="t-l2 c-alt">이상 주문이면 배송비 0원</span>
                  </FormRow>
                )}
                <FormRow
                  label="제주 · 도서산간 추가 배송비"
                  htmlFor="remote"
                  help={
                    <>
                      기본 3,000원 · 0원으로 적으면 추가 배송비를 받지 않습니다 · 무료 배송이어도 붙습니다
                      <br />
                      우편번호로 자동 판별하고 금액은 하나로 같습니다 · 주문서와 주문 완료 화면에 「도서산간 추가」 줄로 따로 보입니다
                    </>
                  }
                >
                  {amountInput("remote", remote, setRemote, shown.remote)}
                </FormRow>
              </FormSection>

              <FormSection title="반품 · 교환 배송비" actions={<span className="t-l2 c-alt">단순 변심일 때만 받습니다 · 상품 불량 · 오배송은 파트너스 부담</span>}>
                <FormRow label="반품 배송비 (편도)" htmlFor="return-fee" help="기본 3,000원">
                  {amountInput("return-fee", returnFee, setReturnFee, shown.returnFee)}
                </FormRow>
                <FormRow label="교환 배송비 (왕복)" htmlFor="exchange-fee" help="기본 6,000원 · 교환 접수가 열리면 적용됩니다">
                  {amountInput("exchange-fee", exchangeFee, setExchangeFee, shown.exchangeFee)}
                </FormRow>
                <FormRow
                  label="안내"
                  help={
                    <>
                      반품하면 처음 낸 배송비는 돌려주지 않고 반품 배송비를 빼고 환불합니다
                      <br />
                      {/* 서버는 주문의 배송비가 0원일 때만 두 배로 뺀다(도서산간 추가비가 붙으면 0원이 아님, queue/service computeRefund) */}
                      무료 배송 주문(배송비 0원)은 반품 배송비 × 2를 뺍니다 · 도서산간 추가 배송비를 낸 주문은 한 번만 뺍니다
                    </>
                  }
                >
                  {null}
                </FormRow>
              </FormSection>

              <FormSection title="받는 방법 · 발송 안내">
                <FormRow label="받는 방법" help="개봉이 끝나면 포장해서 보냅니다 · 지금은 이 방법만 열려 있습니다">
                  <div data-testid="receive-methods" style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
                    {(saved?.receiveMethods ?? []).map((m) => (
                      <label key={m} className="chk">
                        <input type="checkbox" checked disabled aria-label={METHOD_LABEL[m] ?? m} />
                        {METHOD_LABEL[m] ?? m}
                      </label>
                    ))}
                    {extras.planned.map((m) => (
                      <div key={m}>
                        <label className="chk c-alt">
                          <input type="checkbox" checked={false} disabled aria-label={`${METHOD_LABEL[m] ?? m} (곧 열립니다)`} />
                          {METHOD_LABEL[m] ?? m} <span className="t-c1">곧 열립니다</span>
                        </label>
                        <p className="help">개봉한 카드를 모아 두었다가 한 번에 보냅니다 · 보관 기한 · 보관 중 안내는 열릴 때 설정합니다</p>
                      </div>
                    ))}
                  </div>
                </FormRow>
                <FormRow label="발송까지 걸리는 기간" required htmlFor="dispatch-days" help={shown.deadline ? <span className="err">{shown.deadline}</span> : `주문서에 「개봉이 끝나면 ${deadline.trim() || "N"}일 안에 보내요」로 보입니다`}>
                  <input
                    id="dispatch-days"
                    className={`inp num${shown.deadline ? " is-error" : ""}`}
                    type="text"
                    inputMode="numeric"
                    value={deadline}
                    onChange={(e) => setDeadline(e.target.value)}
                    style={{ width: 120 }}
                    aria-invalid={!!shown.deadline}
                  />
                  <span className="t-l2 c-alt">일</span>
                </FormRow>
                <FormRow label="기본 택배사" htmlFor="default-courier" help="배송 화면에서 송장 입력할 때 미리 골라집니다">
                  <select id="default-courier" className="inp" value={courier} onChange={(e) => setCourier(e.target.value)} style={{ width: 200 }}>
                    <option value="">택배사 선택</option>
                    {Object.entries(extras.couriers).map(([code, name]) => (
                      <option key={code} value={code}>
                        {name}
                      </option>
                    ))}
                  </select>
                </FormRow>
              </FormSection>

              <div className="au-two" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 24, marginTop: 24 }}>
                <FormSection title="주문서에 이렇게 보입니다">
                  <div className="card" style={{ padding: "8px 12px" }}>
                    <div>
                      <b>바로 받기</b> <span className="t-l2 c-alt">· 개봉이 끝나면 {deadline.trim() || "N"}일 안에 보내요{summary ? ` · ${summary.replace("배송비 무료", "배송비 0원")}` : ""}</span>
                    </div>
                    {extras.planned.length > 0 && (
                      <div className="c-alt" style={{ margin: "4px 0 8px" }}>
                        보관하기 <span className="t-c1">곧 열립니다</span> <span className="t-l2">· 개봉한 카드를 모아 두었다가 한 번에 받습니다</span>
                      </div>
                    )}
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th scope="col">항목</th>
                          <th scope="col" style={{ width: 200, textAlign: "right" }}>금액</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr>
                          <td className="col-text">상품</td>
                          <td style={{ textAlign: "right" }}>330,000원</td>
                        </tr>
                        <tr>
                          <td className="col-text">이벤트 할인</td>
                          <td style={{ textAlign: "right" }}>−19,800원</td>
                        </tr>
                        <tr>
                          <td className="col-text">배송</td>
                          <td style={{ textAlign: "right" }}>
                            <span className="num" data-testid="fee-preview">
                              {summary ?? "금액을 입력하면 여기에 표시됩니다"}
                            </span>
                          </td>
                        </tr>
                        <tr>
                          <td className="col-text">도서산간 추가</td>
                          <td style={{ textAlign: "right" }}>
                            <span className="num c-alt" data-testid="remote-preview">
                              {remoteNum !== null && !errors.remote ? (remoteNum === 0 ? "받지 않음" : `+${won(remoteNum)} · 해당 주소만`) : "—"}
                            </span>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <p className="help">제주 주소면 「도서산간 추가 +3,000원」 줄이 붙습니다</p>
                  </div>
                </FormSection>
                <FormSection title="반품 · 교환은 이렇게 보입니다">
                  <div className="card" style={{ padding: "8px 12px" }}>
                    반품 · 교환 안내:{" "}
                    <span data-testid="return-preview">
                      「
                      {returnNum !== null && exchangeNum !== null && !errors.returnFee && !errors.exchangeFee
                        ? `단순 변심 반품 배송비 ${won(returnNum)} · 교환 ${won(exchangeNum)}`
                        : "금액을 입력하면 여기에 표시됩니다"}
                      」
                    </span>
                    <p className="help">주문서 · 주문 상세 · 환불 안내에 같이 보입니다</p>
                  </div>
                  <div className="msg msg-info t-l2" role="note" style={{ marginTop: 16 }}>
                    <span>
                      <b>알아 두십시오</b>
                      <br />
                      배송비는 결제 금액에 합산됩니다. 발송 전에 환불하면 배송비까지 모두 돌려줍니다. 발송 뒤 상품 불량 · 오배송이면 상품값과 처음 낸 배송비를 돌려주고, 단순 변심이면 반품 배송비를 빼고 돌려줍니다. 이미 받은 주문의 배송비는 바뀌지 않습니다.
                    </span>
                  </div>
                </FormSection>
              </div>
            </fieldset>
            <FormFoot>
              <button className="btn btn-lg" type="submit" disabled={saving || !dirty}>
                {saving ? "저장 중" : "저장"}
              </button>
              <button className="btn btn-lg btn-out" type="button" disabled={saving || !dirty} onClick={() => saved && (apply(saved), setShowErrors(false), setFailure(null))}>
                취소
              </button>
              <Link className="btn btn-lg btn-out" href="/seller/shipping">
                배송 화면
              </Link>
            </FormFoot>
          </form>
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
