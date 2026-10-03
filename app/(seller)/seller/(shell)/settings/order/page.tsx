"use client";

import { useCallback, useEffect, useState } from "react";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { SettingsTabs } from "../../../../../../components/seller/SettingsTabs";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { parseAmount } from "../../../../../../components/seller/format";

// SA-063 주문 설정: 미입금 자동 취소·입금 기한·자동 구매 제한·재고 되돌리기·자동 배송 완료·자동 구매 확정.
// 반품·교환 배송비는 배송비 정책(SA-061)에서 정한다(API가 배송비 정책에 있음). 마감 전 알림은 API가 생기면 붙인다.

type Policy = {
  autoCancelEnabled: boolean;
  paymentDueHours: number;
  unpaidRestrictionEnabled: boolean;
  restockOnCancel: boolean;
  autoDeliverEnabled: boolean;
  autoDeliverDays: number;
  autoConfirmEnabled: boolean;
  autoConfirmDays: number;
};
type Unit = "day" | "hour";

const DEFAULT_DUE_HOURS = 24; // 대표님 결정 2026-10-03(#87): 기본은 주문 후 24시간
const MAX_DUE_HOURS = 720;
const MAX_AUTO_DAYS = 30; // 자동 배송 완료·구매 확정 기간 1~30일, 기본 7일

function daysError(v: string): string | null {
  const n = parseAmount(v);
  if (n === null) return "숫자만 입력해 주세요";
  if (n < 1 || n > MAX_AUTO_DAYS) return `1일부터 ${MAX_AUTO_DAYS}일까지 정할 수 있어요`;
  return null;
}
const SET_ROW = { padding: "12px 0", gap: 12, boxShadow: "inset 0 -1px 0 var(--wds-line-normal-alternative)" };

// 하루 단위로 딱 떨어지고 이틀 이상이면 「일」, 그 밖에는 「시간」으로 보여 준다
const unitFor = (h: number): Unit => (h % 24 === 0 && h >= 48 ? "day" : "hour");
const dueText = (h: number) => (unitFor(h) === "day" ? `${h / 24}일` : `${h}시간`);

// 자동 배송 완료·구매 확정 한 줄: 스위치 + 켜져 있으면 기간(일) 칸
function autoDaysRow(o: {
  id: string;
  title: string;
  desc: string;
  offDesc: string;
  on: boolean;
  setOn: (f: (v: boolean) => boolean) => void;
  value: string;
  setValue: (v: string) => void;
  err: string | null;
}) {
  return (
    <div className="col" style={{ ...SET_ROW, gap: 10 }}>
      <div className="row between" style={{ gap: 12 }}>
        <span className="col" style={{ gap: 2 }}>
          <span className="t-l1 fw6" id={`${o.id}-label`}>
            {o.title}
          </span>
          <span className="t-c1 c-alt">{o.on ? o.desc : o.offDesc}</span>
        </span>
        <button className={`sw${o.on ? " on" : ""}`} type="button" role="switch" aria-checked={o.on} aria-labelledby={`${o.id}-label`} onClick={() => o.setOn((v) => !v)} />
      </div>
      {o.on && (
        <div className="fld" style={{ width: 160 }}>
          <label htmlFor={`${o.id}-days`}>{o.id === "deliver" ? "자동 배송 완료 기간" : "자동 구매 확정 기간"}</label>
          <div style={{ position: "relative" }}>
            <input
              id={`${o.id}-days`}
              className={`inp num${o.err ? " is-error" : ""}`}
              type="text"
              inputMode="numeric"
              value={o.value}
              onChange={(e) => o.setValue(e.target.value)}
              style={{ textAlign: "right", paddingRight: 32 }}
              aria-invalid={!!o.err}
            />
            <span className="t-l2 c-alt amount-unit" aria-hidden="true">
              일
            </span>
          </div>
          {o.err ? <span className="err">{o.err}</span> : <span className="help">1~{MAX_AUTO_DAYS}일</span>}
        </div>
      )}
    </div>
  );
}

export default function OrderSettingsPage() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; saved: Policy }>({ kind: "loading" });
  const [autoCancel, setAutoCancel] = useState(true);
  const [due, setDue] = useState("");
  const [unit, setUnit] = useState<Unit>("hour");
  const [restriction, setRestriction] = useState(true);
  const [restock, setRestock] = useState(true);
  const [deliverOn, setDeliverOn] = useState(true);
  const [deliverDays, setDeliverDays] = useState("");
  const [confirmOn, setConfirmOn] = useState(true);
  const [confirmDays, setConfirmDays] = useState("");
  const [showError, setShowError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const apply = (p: Policy) => {
    setAutoCancel(p.autoCancelEnabled);
    setUnit(unitFor(p.paymentDueHours));
    setDue(String(unitFor(p.paymentDueHours) === "day" ? p.paymentDueHours / 24 : p.paymentDueHours));
    setRestriction(p.unpaidRestrictionEnabled);
    setRestock(p.restockOnCancel);
    setDeliverOn(p.autoDeliverEnabled);
    setDeliverDays(String(p.autoDeliverDays));
    setConfirmOn(p.autoConfirmEnabled);
    setConfirmDays(String(p.autoConfirmDays));
  };

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const r = await api<{ policy: Policy }>("/api/seller/order-policy");
    if (!r.ok) return setState({ kind: "error", status: r.status });
    apply(r.data.policy);
    setState({ kind: "ok", saved: r.data.policy });
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const n = parseAmount(due);
  const hours = n === null ? null : unit === "day" ? n * 24 : n;
  const dueError =
    n === null ? "숫자만 입력해 주세요" : n < 1 ? "1 이상으로 적어 주세요 · 자동 취소를 끄려면 위 스위치를 꺼 주세요" : hours! > MAX_DUE_HOURS ? "입금 기한은 30일(720시간)까지 정할 수 있어요" : null;
  const saved = state.kind === "ok" ? state.saved : null;
  // 자동 취소를 끄면 입금 기한 칸은 숨기고 검사하지 않는다. 틀린 값이면 저장된 값을 그대로 쓴다(버튼 상태도 같은 기준)
  const effectiveHours = autoCancel || !dueError ? hours : saved?.paymentDueHours ?? null;
  // 자동 배송 완료·구매 확정 기간도 같은 기준: 끄면 칸을 숨기고, 틀린 값이면 저장된 값을 쓴다
  const deliverError = daysError(deliverDays);
  const confirmError = daysError(confirmDays);
  const effectiveDeliver = deliverOn || !deliverError ? parseAmount(deliverDays) : saved?.autoDeliverDays ?? null;
  const effectiveConfirm = confirmOn || !confirmError ? parseAmount(confirmDays) : saved?.autoConfirmDays ?? null;
  const dirty =
    !!saved &&
    (saved.autoCancelEnabled !== autoCancel ||
      saved.unpaidRestrictionEnabled !== restriction ||
      saved.restockOnCancel !== restock ||
      saved.paymentDueHours !== effectiveHours ||
      saved.autoDeliverEnabled !== deliverOn ||
      saved.autoDeliverDays !== effectiveDeliver ||
      saved.autoConfirmEnabled !== confirmOn ||
      saved.autoConfirmDays !== effectiveConfirm);

  // 입금 기한 칸은 자동 취소를 꺼도 값을 남겨 둔다(다시 켤 때 그대로 쓰도록). 꺼져 있으면 검사하지 않고 저장된 값을 보낸다.
  const save = async () => {
    if (!saved) return;
    if ((autoCancel && dueError) || (deliverOn && deliverError) || (confirmOn && confirmError)) {
      setShowError(true);
      return;
    }
    setSaving(true);
    setFailure(null);
    const body: Policy = {
      autoCancelEnabled: autoCancel,
      paymentDueHours: effectiveHours!,
      unpaidRestrictionEnabled: restriction,
      restockOnCancel: restock,
      autoDeliverEnabled: deliverOn,
      autoDeliverDays: effectiveDeliver!,
      autoConfirmEnabled: confirmOn,
      autoConfirmDays: effectiveConfirm!,
    };
    const r = await api<{ policy: Policy }>("/api/seller/order-policy", { method: "PUT", body });
    setSaving(false);
    if (!r.ok) return setFailure(failMessage(r, "저장하지 못했어요. 잠시 뒤 다시 시도해 주세요"));
    apply(r.data.policy);
    setState({ kind: "ok", saved: r.data.policy });
    setShowError(false);
    setToast("주문 설정을 저장했어요 · 다음 주문부터 적용돼요");
  };

  const changeUnit = (u: Unit) => {
    if (u === unit) return;
    // 단위를 바꿔도 같은 기간이 되게 숫자를 바꿔 준다(딱 떨어지지 않으면 그대로 둔다)
    if (n !== null && u === "hour") setDue(String(n * 24));
    if (n !== null && u === "day" && n % 24 === 0) setDue(String(n / 24));
    setUnit(u);
  };

  const preview = hours !== null && !dueError ? dueText(hours) : null;

  return (
    <>
      <Topbar crumb="설정 › 쇼핑몰 설정 › 주문 설정">
        {saved && (
          <button className="btn btn-sm" type="button" onClick={() => void save()} disabled={saving || !dirty}>
            {saving ? "저장하고 있어요" : "저장"}
          </button>
        )}
      </Topbar>
      <main className="main">
        <SettingsTabs />
        <div className="ph">
          <div className="col" style={{ gap: 6 }}>
            <h1 className="t-t3">주문 설정</h1>
            <span className="t-l2 c-alt">미입금 취소 · 재고 · 배송 완료 · 구매 확정 규칙이에요. 저장하면 다음 주문부터 적용돼요.</span>
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
                <ErrorState title="주문 설정을 불러오지 못했어요" onRetry={() => void load()} />
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
              <section className="card pad col" style={{ gap: 10 }}>
                <h2 className="t-hl2">미입금 주문 자동 취소</h2>
                {/* 자동 취소·주문 막기를 실제로 돌리는 정기 실행이 아직 연결되지 않았다(HANDOFF 「미입금 자동 취소 정기 실행 미연결」). 연결되면 이 안내를 지운다 */}
                <div className="msg msg-cau" role="note" data-testid="auto-cancel-pending">
                  <span>
                    <b>아직 자동으로 취소되지 않아요.</b> 정해 둔 설정은 저장되고, 자동 취소가 시작되면 그대로 적용돼요. 그 전까지는 기한이 지난 주문을 직접 취소해 주세요.
                  </span>
                </div>
                <div className="row between" style={SET_ROW}>
                  <span className="col" style={{ gap: 2 }}>
                    <span className="t-l1 fw6" id="ac-label">
                      기한이 지나면 자동 취소
                    </span>
                    <span className="t-c1 c-alt">
                      {autoCancel
                        ? "무통장 주문이 기한 안에 입금되지 않으면 취소돼요 · 기본 켜짐"
                        : "꺼 두면 미입금 주문이 그대로 남아요 · 입금 확인에서 직접 취소해요"}
                    </span>
                  </span>
                  <button
                    className={`sw${autoCancel ? " on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={autoCancel}
                    aria-labelledby="ac-label"
                    onClick={() => setAutoCancel((v) => !v)}
                  />
                </div>
                {autoCancel ? (
                  <>
                    <div className="row" style={{ gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
                      <div className="fld" style={{ width: 160 }}>
                        <label htmlFor="due">입금 기한</label>
                        <input
                          id="due"
                          className={`inp num${showError && dueError ? " is-error" : ""}`}
                          type="text"
                          inputMode="numeric"
                          value={due}
                          onChange={(e) => setDue(e.target.value)}
                          style={{ textAlign: "right" }}
                          aria-invalid={showError && !!dueError}
                        />
                      </div>
                      <div className="fld">
                        <span className="lbl">단위</span>
                        <div className="seg" role="radiogroup" aria-label="입금 기한 단위" style={{ alignSelf: "flex-start" }}>
                          <button type="button" role="radio" aria-checked={unit === "day"} className={unit === "day" ? "on" : ""} onClick={() => changeUnit("day")}>
                            일
                          </button>
                          <button type="button" role="radio" aria-checked={unit === "hour"} className={unit === "hour" ? "on" : ""} onClick={() => changeUnit("hour")}>
                            시간
                          </button>
                        </div>
                      </div>
                    </div>
                    {showError && dueError ? (
                      <span className="err">{dueError}</span>
                    ) : (
                      <span className="help">
                        기본 {DEFAULT_DUE_HOURS}시간 · 1시간부터 30일까지 정할 수 있어요{preview ? ` · 구매자에게 「주문 후 ${preview} 안에 입금」으로 보여요` : ""}
                      </span>
                    )}
                  </>
                ) : (
                  <span className="t-c1 c-cau">미입금 주문이 쌓이면 재고가 묶여요</span>
                )}
              </section>

              <section className="card pad col" style={{ gap: 10 }}>
                <h2 className="t-hl2">미입금 구매자 주문 막기</h2>
                <div className="row between" style={SET_ROW}>
                  <span className="col" style={{ gap: 2 }}>
                    <span className="t-l1 fw6" id="rs-label">
                      미입금으로 3번 취소되면 30일 동안 주문 막기
                    </span>
                    <span className="t-c1 c-alt">같은 구매자의 주문이 입금 기한을 넘겨 3번 자동 취소되면 30일 동안 새 주문을 받지 않아요 · 기본 켜짐</span>
                  </span>
                  <button
                    className={`sw${restriction ? " on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={restriction}
                    aria-labelledby="rs-label"
                    onClick={() => setRestriction((v) => !v)}
                  />
                </div>
                <span className="t-c1 c-alt">꺼도 이미 막힌 구매자는 그대로예요. 풀어 주려면 구매 제한 화면에서 해제해요.</span>
                {/* 3회 판정은 미입금 자동 취소가 돌아야 생긴다. 정기 실행이 연결되면 지운다 */}
                <span className="t-c1 c-cau" data-testid="restriction-pending">
                  아직 자동 취소가 시작되지 않아서 주문 막기도 시작되지 않았어요. 자동 취소가 시작되면 함께 적용돼요.
                </span>
              </section>

              <section className="card pad col" style={{ gap: 10 }}>
                <h2 className="t-hl2">재고</h2>
                <div className="row between" style={SET_ROW}>
                  <span className="col" style={{ gap: 2 }}>
                    <span className="t-l1 fw6" id="rc-label">
                      취소·반품하면 재고 되돌리기
                    </span>
                    <span className="t-c1 c-alt">결제 전 취소·미입금 자동 취소·발송 전 환불이 끝나면 그 수량만큼 재고가 돌아와요 · 기본 켜짐</span>
                  </span>
                  <button
                    className={`sw${restock ? " on" : ""}`}
                    type="button"
                    role="switch"
                    aria-checked={restock}
                    aria-labelledby="rc-label"
                    onClick={() => setRestock((v) => !v)}
                  />
                </div>
                <span className="t-c1 c-alt">재고를 언제 줄일지는 상품마다 「재고 차감 기준」에서 정해요(결제하면 차감 · 주문하면 바로 차감).</span>
              </section>

              <section className="card pad col" style={{ gap: 10 }}>
                <h2 className="t-hl2">배송 완료 · 구매 확정</h2>
                {/* 자동 배송 완료·구매 확정을 실제로 돌리는 정기 실행이 아직 연결되지 않았다(HANDOFF 「배송」). 연결되면 이 안내를 지운다 */}
                <div className="msg msg-cau" role="note" data-testid="auto-deliver-pending">
                  <span>
                    <b>아직 자동으로 바뀌지 않아요.</b> 정해 둔 설정은 저장되고, 자동 처리가 시작되면 그대로 적용돼요.
                  </span>
                </div>
                {autoDaysRow({
                  id: "deliver",
                  title: "배송 중 n일 뒤 자동으로 배송 완료",
                  desc: "송장을 올린 뒤 배송 중 상태가 이 기간 지나면 자동으로 배송 완료가 돼요 · 기본 7일",
                  offDesc: "꺼 두면 배송 완료는 직접 바꿔요",
                  on: deliverOn,
                  setOn: setDeliverOn,
                  value: deliverDays,
                  setValue: setDeliverDays,
                  err: showError && deliverOn ? deliverError : null,
                })}
                {autoDaysRow({
                  id: "confirm",
                  title: "배송 완료 n일 뒤 자동 구매 확정",
                  desc: "구매자가 확정하지 않아도 이 기간이 지나면 구매 확정돼요 · 기본 7일",
                  offDesc: "꺼 두면 구매자가 확정할 때까지 기다려요",
                  on: confirmOn,
                  setOn: setConfirmOn,
                  value: confirmDays,
                  setValue: setConfirmDays,
                  err: showError && confirmOn ? confirmError : null,
                })}
              </section>
            </div>

            <aside className="col aside-sticky" style={{ gap: 16 }}>
              <div className="card pad col" style={{ gap: 10 }}>
                <span className="t-hl2">구매자에게 이렇게 보여요</span>
                <div className="col" style={{ gap: 8, padding: 12, borderRadius: 10, background: "var(--wds-fill-alternative)" }}>
                  <span className="t-l2" data-testid="buyer-preview">
                    {autoCancel
                      ? preview
                        ? `주문서 · 무통장 입금: 「주문 후 ${preview} 안에 입금하면 주문대기에 올라가요」`
                        : "입금 기한을 입력하면 여기에 보여요"
                      : "주문서 · 무통장 입금: 입금 기한 안내가 보이지 않아요"}
                  </span>
                  <span className="t-l2" data-testid="delivery-preview">
                    주문 상세: 「
                    {[
                      deliverOn && !deliverError ? `배송 중 ${parseAmount(deliverDays)}일이 지나면 배송 완료로 바뀌어요` : null,
                      confirmOn && !confirmError ? `배송 완료 ${parseAmount(confirmDays)}일 뒤 자동으로 구매 확정돼요` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "배송 완료 · 구매 확정은 직접 처리해요"}
                    」
                  </span>
                </div>
              </div>
              <div className="card pad col" style={{ gap: 8 }}>
                <span className="t-hl2">알아 두세요</span>
                <span className="t-c1 c-alt" style={{ lineHeight: 1.6 }}>
                  바꾼 기한은 저장한 뒤 들어오는 주문부터 적용돼요. 이미 받은 주문의 입금 기한은 그대로예요. 반품 · 교환 배송비는 「배송비 정책」에서 정해요.
                </span>
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
