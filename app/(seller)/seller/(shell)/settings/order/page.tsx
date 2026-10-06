"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FormFoot, FormRow, FormSection, PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { parseAmount } from "../../../../../../components/seller/format";
import { useUnsavedGuard } from "../../../../../../lib/client/navigation";

// SA-063 주문 설정: 미입금 자동 취소·입금 기한·자동 구매 제한(미입금·결제 후 취소)·재고 되돌리기·자동 배송 완료·자동 구매 확정.
// 반품·교환 배송비는 배송비 정책(SA-061)에서 정한다(API가 배송비 정책에 있음). 마감 알림·배송 자동 조회는 order-policy의 dueReminderEnabled·autoTrackingEnabled(#713).

type Policy = {
  autoCancelEnabled: boolean;
  paymentDueHours: number;
  unpaidRestrictionEnabled: boolean;
  paidCancelRestrictionEnabled: boolean;
  restockOnCancel: boolean;
  autoDeliverEnabled: boolean;
  autoDeliverDays: number;
  autoConfirmEnabled: boolean;
  autoConfirmDays: number;
  dueReminderEnabled: boolean;
  autoTrackingEnabled: boolean;
};
type Unit = "day" | "hour";

const DEFAULT_DUE_HOURS = 24; // 대표님 결정 2026-10-03(#87): 기본은 주문 후 24시간
const MAX_DUE_HOURS = 720;
const MAX_AUTO_DAYS = 30; // 자동 배송 완료·구매 확정 기간 1~30일, 기본 7일

function daysError(v: string): string | null {
  if (v.trim() === "") return "기간을 입력해 주십시오";
  const n = parseAmount(v);
  if (n === null) return "숫자만 입력해 주십시오";
  if (n < 1 || n > MAX_AUTO_DAYS) return `1일부터 ${MAX_AUTO_DAYS}일까지 정할 수 있습니다`;
  return null;
}
// 하루 단위로 딱 떨어지고 이틀 이상이면 「일」, 그 밖에는 「시간」으로 보여 준다
const unitFor = (h: number): Unit => (h % 24 === 0 && h >= 48 ? "day" : "hour");
const dueText = (h: number) => (unitFor(h) === "day" ? `${h / 24}일` : `${h}시간`);

export default function OrderSettingsPage() {
  const { confirm } = useConfirm();
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; saved: Policy }>({ kind: "loading" });
  const [autoCancel, setAutoCancel] = useState(true);
  const [due, setDue] = useState("");
  const [unit, setUnit] = useState<Unit>("hour");
  const [restriction, setRestriction] = useState(true);
  const [paidRestriction, setPaidRestriction] = useState(false);
  const [restock, setRestock] = useState(true);
  const [deliverOn, setDeliverOn] = useState(true);
  const [deliverDays, setDeliverDays] = useState("");
  const [confirmOn, setConfirmOn] = useState(true);
  const [confirmDays, setConfirmDays] = useState("");
  const [dueReminder, setDueReminder] = useState(true);
  const [tracking, setTracking] = useState(false);
  // 배송 자동 조회 단가(발송·이용 충전 API, 대표자만 읽을 수 있다). 못 읽으면 단가 없이 안내만 하고, 정해지기 전이면 빈 문자열이다
  const [trackingFee, setTrackingFee] = useState<string | null>(null);
  const [showError, setShowError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const apply = (p: Policy) => {
    setAutoCancel(p.autoCancelEnabled);
    setUnit(unitFor(p.paymentDueHours));
    setDue(String(unitFor(p.paymentDueHours) === "day" ? p.paymentDueHours / 24 : p.paymentDueHours));
    setRestriction(p.unpaidRestrictionEnabled);
    setPaidRestriction(p.paidCancelRestrictionEnabled);
    setRestock(p.restockOnCancel);
    setDeliverOn(p.autoDeliverEnabled);
    setDeliverDays(String(p.autoDeliverDays));
    setConfirmOn(p.autoConfirmEnabled);
    setConfirmDays(String(p.autoConfirmDays));
    setDueReminder(p.dueReminderEnabled);
    setTracking(p.autoTrackingEnabled);
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
  useEffect(() => {
    void api<{ chargingEnabled: boolean; prices: { channel: string; unitPrice: number }[] }>("/api/seller/message-balance").then((r) => {
      if (!r.ok) return;
      const p = r.data.prices.find((x) => x.channel === "DELIVERY_TRACKING");
      // 충전 기능이 꺼져 있고 0원이면 아직 정해지지 않은 값이다
      setTrackingFee(!p || (!r.data.chargingEnabled && p.unitPrice === 0) ? "" : p.unitPrice.toLocaleString("ko-KR"));
    });
  }, []);

  const n = parseAmount(due);
  const hours = n === null ? null : unit === "day" ? n * 24 : n;
  const dueError =
    n === null ? "숫자만 입력해 주십시오" : n < 1 ? "1 이상으로 입력해 주십시오 · 자동 취소를 끄려면 위 체크를 풀어 주십시오" : hours! > MAX_DUE_HOURS ? "입금 기한은 30일(720시간)까지 정할 수 있습니다" : null;
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
      saved.paidCancelRestrictionEnabled !== paidRestriction ||
      saved.restockOnCancel !== restock ||
      saved.paymentDueHours !== effectiveHours ||
      saved.autoDeliverEnabled !== deliverOn ||
      saved.autoDeliverDays !== effectiveDeliver ||
      saved.autoConfirmEnabled !== confirmOn ||
      saved.autoConfirmDays !== effectiveConfirm ||
      saved.dueReminderEnabled !== dueReminder ||
      saved.autoTrackingEnabled !== tracking);
  useUnsavedGuard(dirty); // 링크·브라우저 Back·새로고침에 같은 확인(docs/IA.md Back 규칙 7항)

  // 입금 기한 칸은 자동 취소를 꺼도 값을 남겨 둔다(다시 켤 때 그대로 쓰도록). 꺼져 있으면 검사하지 않고 저장된 값을 보낸다.
  const save = async () => {
    if (!saved) return;
    if ((autoCancel && dueError) || (deliverOn && deliverError) || (confirmOn && confirmError)) {
      setShowError(true);
      return;
    }
    if (!(await confirm({ title: "주문 설정을 저장하시겠습니까?", body: "바뀐 내용은 저장한 뒤 들어오는 주문부터 적용됩니다. 이미 접수된 주문은 그대로입니다.", confirmLabel: "저장" }))) return;
    setSaving(true);
    setFailure(null);
    const body: Policy = {
      autoCancelEnabled: autoCancel,
      paymentDueHours: effectiveHours!,
      unpaidRestrictionEnabled: restriction,
      paidCancelRestrictionEnabled: paidRestriction,
      restockOnCancel: restock,
      autoDeliverEnabled: deliverOn,
      autoDeliverDays: effectiveDeliver!,
      autoConfirmEnabled: confirmOn,
      autoConfirmDays: effectiveConfirm!,
      dueReminderEnabled: dueReminder,
      autoTrackingEnabled: tracking,
    };
    const r = await api<{ policy: Policy }>("/api/seller/order-policy", { method: "PUT", body });
    setSaving(false);
    if (!r.ok) return setFailure(failMessage(r, "admin", "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
    apply(r.data.policy);
    setState({ kind: "ok", saved: r.data.policy });
    setShowError(false);
    setToast("주문 설정을 저장했습니다");
  };

  const changeUnit = (u: Unit) => {
    if (u === unit) return;
    // 단위를 바꿔도 같은 기간이 되게 숫자를 바꿔 준다(딱 떨어지지 않으면 그대로 둔다)
    if (n !== null && u === "hour") setDue(String(n * 24));
    if (n !== null && u === "day" && n % 24 === 0) setDue(String(n / 24));
    setUnit(u);
  };

  const preview = hours !== null && !dueError ? dueText(hours) : null;

  // 체크박스 한 칸(정본 .ck): 이름은 옆 글자
  const ck = (title: string, on: boolean, toggle: () => void) => (
    <label className="chk">
      <input type="checkbox" checked={on} onChange={toggle} />
      {title}
    </label>
  );
  // 기간(일) 칸: 값은 왼쪽 정렬, 단위는 칸 오른쪽
  const daysInput = (id: string, value: string, set: (v: string) => void, err: string | null) => (
    <>
      <input id={id} className={`inp num${err ? " is-error" : ""}`} type="text" inputMode="numeric" value={value} onChange={(e) => set(e.target.value)} style={{ width: 160 }} aria-invalid={!!err} />
      <span className="t-l2 c-alt">일</span>
      {err && <span className="err">{err}</span>}
    </>
  );

  return (
    <>
      <Topbar crumb="설정 › 주문 · 배송 설정 › 주문 설정" />
      <main className="main">
        <PageHead description="입금 기한과 주문 제한, 주문 자동 처리 기준을 설정합니다." title="주문 설정" />

        {state.kind !== "ok" ? (
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={5} />}
            {state.kind === "error" &&
              (state.status === 403 ? (
                <NoPermission need="쇼핑몰 설정" />
              ) : state.status === 402 ? (
                <Locked />
              ) : (
                <ErrorState title="주문 설정을 불러오지 못했습니다" onRetry={() => void load()} />
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

              {/* 자동 취소·주문 막기를 실제로 돌리는 정기 실행이 아직 연결되지 않았다(HANDOFF 「미입금 자동 취소 정기 실행 미연결」). 연결되면 이 안내를 지운다 */}
              <div className="msg msg-cau" role="note" data-testid="auto-cancel-pending" style={{ marginBottom: 16 }}>
                <span>
                  <b>아직 자동으로 취소되지 않습니다.</b> 정해 둔 설정은 저장되고, 자동 취소가 시작되면 그대로 적용됩니다. 그 전까지는 기한이 지난 주문을 직접 취소해 주십시오.
                </span>
              </div>
              <FormSection title="미입금 주문 자동 취소">
                <FormRow
                  label="자동 취소"
                  help={
                    <>
                      {autoCancel
                        ? "무통장 주문이 기한 안에 입금되지 않으면 취소됩니다 · 재고가 돌아가고 구매자에게 알립니다 · 기본 켜짐"
                        : "꺼 두면 미입금 주문이 그대로 남습니다 · 입금 확인에서 직접 취소합니다"}
                      {!autoCancel && (
                        <>
                          <br />
                          <span className="c-cau">미입금 주문이 쌓이면 재고가 묶입니다</span>
                        </>
                      )}
                    </>
                  }
                >
                  {ck("기한이 지나면 자동으로 취소합니다", autoCancel, () => setAutoCancel((v) => !v))}
                </FormRow>
                {autoCancel && (
                  <FormRow
                    label="입금 기한"
                    required
                    htmlFor="due"
                    help={
                      showError && dueError ? (
                        <span className="err">{dueError}</span>
                      ) : (
                        <>
                          기본 {DEFAULT_DUE_HOURS}시간 · 1시간부터 30일까지 정할 수 있습니다{preview ? ` · 주문서 · 주문 완료 · 입금 안내에 「주문 후 ${preview} 안에 입금」으로 보입니다` : ""}
                        </>
                      )
                    }
                  >
                    <input
                      id="due"
                      className={`inp num${showError && dueError ? " is-error" : ""}`}
                      type="text"
                      inputMode="numeric"
                      value={due}
                      onChange={(e) => setDue(e.target.value)}
                      style={{ width: 160 }}
                      aria-invalid={showError && !!dueError}
                    />
                    <select className="inp" aria-label="입금 기한 단위" value={unit} onChange={(e) => changeUnit(e.target.value as Unit)} style={{ width: 120 }}>
                      <option value="hour">시간</option>
                      <option value="day">일</option>
                    </select>
                  </FormRow>
                )}
                {autoCancel && (
                  <FormRow label="마감 알림" help="알림톡으로 입금을 한 번 더 안내합니다 · 안 되면 문자로 보냅니다">
                    {ck("마감 1시간 전 알림", dueReminder, () => setDueReminder((v) => !v))}
                  </FormRow>
                )}
              </FormSection>

              <FormSection title="주문 막기" actions={<span className="t-l2 c-alt">회원별 해제는 「구매 제한」 화면</span>}>
                <FormRow
                  label="미입금 구매자"
                  help={
                    <>
                      같은 구매자의 주문이 입금 기한을 넘겨 3번 자동 취소되면 30일 동안 새 주문을 받지 않습니다 · 기본 켜짐
                      <br />
                      꺼도 이미 막힌 구매자는 그대로입니다 · 풀어 주려면 구매 제한 화면에서 해제합니다
                    </>
                  }
                >
                  {ck("미입금으로 3번 취소되면 30일 동안 주문 막기", restriction, () => setRestriction((v) => !v))}
                </FormRow>
                <FormRow
                  label="결제 후 취소가 잦은 구매자"
                  help={
                    paidRestriction
                      ? "결제 후 구매자 사정으로 5번 취소하면 30일 동안 주문을 막습니다 · 켠 뒤부터 집계합니다 · 파트너스 사정으로 환불한 주문은 세지 않습니다"
                      : "결제 후 구매자 사정으로 5번 취소하면 30일 동안 주문을 막습니다 · 기본 꺼짐 · 파트너스 사정으로 환불한 주문은 세지 않습니다"
                  }
                >
                  {ck("결제 후 5번 취소하면 30일 동안 주문 막기", paidRestriction, () => setPaidRestriction((v) => !v))}
                </FormRow>
              </FormSection>
              {/* 3회 판정은 미입금 자동 취소가 돌아야 생긴다. 정기 실행이 연결되면 지운다 */}
              <p className="help c-cau" data-testid="restriction-pending">
                아직 자동 취소가 시작되지 않아 주문 막기도 시작되지 않았습니다. 자동 취소가 시작되면 함께 적용됩니다.
              </p>

              <FormSection title="재고">
                <FormRow
                  label="재고 되돌리기"
                  help={
                    <>
                      취소 · 반품이 끝나면 그 수량만큼 재고가 자동으로 돌아옵니다 · 기본 켜짐
                      <br />
                      재고를 언제 줄일지는 상품마다 「재고 차감 기준」에서 정합니다 (결제하면 차감 · 주문하면 바로 차감)
                    </>
                  }
                >
                  {ck("취소 · 반품하면 재고 되돌리기", restock, () => setRestock((v) => !v))}
                </FormRow>
              </FormSection>

              {/* 자동 배송 완료·구매 확정을 실제로 돌리는 정기 실행이 아직 연결되지 않았다(HANDOFF 「배송」). 연결되면 이 안내를 지운다 */}
              <div className="msg msg-cau" role="note" data-testid="auto-deliver-pending" style={{ margin: "24px 0 0" }}>
                <span>
                  <b>아직 자동으로 바뀌지 않습니다.</b> 정해 둔 설정은 저장되고, 자동 처리가 시작되면 그대로 적용됩니다.
                </span>
              </div>
              <FormSection title="배송 완료 · 구매 확정">
                <FormRow label="자동 배송 완료" help={deliverOn ? "송장을 올린 뒤 배송 중으로 기본 7일이 지나면 바뀝니다" : "꺼 두면 배송 완료는 직접 변경합니다"}>
                  {ck("일정 기간이 지나면 배송 완료로 바꿉니다", deliverOn, () => setDeliverOn((v) => !v))}
                </FormRow>
                <FormRow
                  label="배송 자동 조회"
                  help={
                    <span data-testid="tracking-fee">
                      {tracking
                        ? `켜면 송장 1건 조회당 ${trackingFee === null ? "비용이" : trackingFee === "" ? "단가 확정 전 금액이" : `${trackingFee}원이`} 발송·이용 충전금에서 차감됩니다 · 단가는 발송·이용 충전에서 봅니다`
                        : "끄면 구매자에게 택배사 조회 페이지 링크만 보여 드리며 비용이 없습니다 · 잔액은 발송·이용 충전에서 봅니다"}
                    </span>
                  }
                >
                  <div className="row" role="radiogroup" aria-label="배송 자동 조회" style={{ gap: 24, flexWrap: "wrap" }}>
                    <label className="chk">
                      <input type="radio" name="auto-tracking" checked={tracking} onChange={() => setTracking(true)} />
                      켬 · 송장 자동 조회
                    </label>
                    <label className="chk">
                      <input type="radio" name="auto-tracking" checked={!tracking} onChange={() => setTracking(false)} />
                      끔 · 택배사 조회 링크만 (기본)
                    </label>
                  </div>
                </FormRow>
                {deliverOn && (
                  <FormRow label="자동 배송 완료 기간" htmlFor="deliver-days" help={showError && deliverError ? undefined : `1~${MAX_AUTO_DAYS}일 · 기본 7일`}>
                    {daysInput("deliver-days", deliverDays, setDeliverDays, showError ? deliverError : null)}
                  </FormRow>
                )}
                <FormRow
                  label="자동 구매 확정"
                  help={confirmOn ? "구매자가 직접 확정하지 않아도 됩니다 · 기본 7일" : "꺼 두면 구매자가 확정할 때까지 기다립니다"}
                >
                  {ck("배송 완료 뒤 일정 기간이 지나면 구매 확정합니다", confirmOn, () => setConfirmOn((v) => !v))}
                </FormRow>
                {confirmOn && (
                  <FormRow
                    label="자동 구매 확정 기간"
                    htmlFor="confirm-days"
                    help={
                      showError && confirmError ? undefined : (
                        <>
                          1~{MAX_AUTO_DAYS}일 · 기본 7일
                          {/* 서버는 주문마다 기간을 따로 저장하지 않고 지금 설정으로 계산한다(orders/delivery.ts) */}
                          <span data-testid="delivery-existing"> · 기간을 바꾸면 이미 배송 중이거나 배송 완료된 주문도 바뀐 기간으로 계산합니다</span>
                        </>
                      )
                    }
                  >
                    {daysInput("confirm-days", confirmDays, setConfirmDays, showError ? confirmError : null)}
                  </FormRow>
                )}
              </FormSection>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 24, marginTop: 24 }}>
                <FormSection title="구매자에게 이렇게 보입니다">
                  <div className="card" style={{ padding: "8px 12px", lineHeight: "20px" }}>
                    <span data-testid="buyer-preview">
                      {autoCancel
                        ? preview
                          ? `주문서 · 무통장 입금: 「주문 후 ${preview} 안에 입금하면 주문대기에 올라가요」`
                          : "입금 기한을 입력하면 여기에 표시됩니다"
                        : "주문서 · 무통장 입금: 입금 기한 안내가 표시되지 않습니다"}
                    </span>
                    <br />
                    <span data-testid="delivery-preview">
                      주문 상세: 「
                      {[
                        deliverOn && !deliverError ? `배송 중 ${parseAmount(deliverDays)}일이 지나면 배송 완료로 바뀝니다` : null,
                        confirmOn && !confirmError ? `배송 완료 ${parseAmount(confirmDays)}일 뒤 자동으로 구매 확정됩니다` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ") || "배송 완료 · 구매 확정은 직접 처리합니다"}
                      」
                    </span>{" "}
                    <span className="t-c1 c-alt">자동 처리 시작 뒤</span>
                  </div>
                </FormSection>
                <FormSection title="알아 두십시오">
                  <div className="msg msg-info t-l2" role="note">
                    <span>
                      기한 안에 입금되지 않은 주문은 자동 취소되고 재고가 돌아옵니다. 적립금은 적립 정책의 지급 시점(기본 배송 완료 후 · 결제하면 바로 지급 선택 가능)에 따라 쌓입니다. 구매 확정 뒤 환불 요청은 문의로만 받습니다. 배송비 금액은 「배송 설정」에서 정합니다.
                    </span>
                  </div>
                  <Link className="btn btn-sm btn-out" href="/seller/settings/shipping" style={{ marginTop: 8 }}>
                    배송 설정
                  </Link>
                </FormSection>
              </div>
            </fieldset>
            <FormFoot>
              <button className="btn btn-lg" type="submit" disabled={saving || !dirty}>
                {saving ? "저장 중" : "저장"}
              </button>
              <button className="btn btn-lg btn-out" type="button" disabled={saving || !dirty} onClick={() => saved && (apply(saved), setShowError(false), setFailure(null))}>
                취소
              </button>
            </FormFoot>
          </form>
        )}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
