"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FormRow, FormSection, Modal, PageHead } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Locked, NoPermission, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { parseAmount, won } from "../../../../../../components/seller/format";
import { MESSAGE_FEE_NOTICE } from "../../../../../../components/seller/messageFeeNotice";

// SA-081 발송·이용 충전(대표자 전용). API: GET·PUT /api/seller/message-balance, POST …/consent, GET …/ledger.
// 충전: POST …/charges(구독 결제 카드). 금액은 비워 두고 시작하며 확인 창을 거친다. 충전 스위치가 꺼져 있으면 잠근다. 유료 잔액 환불 API는 아직 없다.
// 비용 안내 문구는 docs/terms/SELLER_MESSAGE_FEE_NOTICE.md 서식 그대로(components/seller/messageFeeNotice.ts).

type Channel = "MAIL_TRANSACTIONAL" | "MAIL_BULK" | "SMS" | "LMS" | "ALIMTALK" | "IDENTITY_VERIFICATION" | "DELIVERY_TRACKING";
type Balance = {
  paidBalance: number;
  freeBalance: number;
  total: number;
  lowBalanceThreshold: number;
  lowBalance: boolean;
  chargingEnabled: boolean;
  noticeVersion: string;
  consent: { version: string; consentedAt: string } | null;
  prices: { channel: Channel; unitPrice: number; next: { unitPrice: number; effectiveAt: string } | null }[];
  mail: { month: string; quota: number; sent: number; freeSent: number; chargedSent: number; pending: number; skippedBalance: number; skippedPlatformLimit: number; failed: number };
};
type Entry = {
  id: string;
  type: "CHARGE" | "GRANT" | "DEBIT" | "REFUND";
  status: "PENDING" | "SUCCEEDED" | "REVERSED";
  channel: Channel | null;
  quantity: number | null;
  unitPrice: number | null;
  paidAmount: number;
  freeAmount: number;
  reason: string | null;
  createdAt: string;
};
type Ledger = { kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; entries: Entry[]; next: string | null };

const MAX_THRESHOLD = 10_000_000;
const CHARGE_MIN = 1_000;
const CHARGE_MAX = 1_000_000;
const CHARGE_UNIT = 1_000;
const TBD = "[확정 전]";
const CHANNEL: Record<Channel, string> = {
  MAIL_TRANSACTIONAL: "거래 메일(제공량 초과분)",
  MAIL_BULK: "대량 메일",
  SMS: "문자",
  LMS: "긴 문자",
  ALIMTALK: "알림톡",
  IDENTITY_VERIFICATION: "구매자 본인인증",
  DELIVERY_TRACKING: "배송 자동 조회",
};
const TYPE: Record<Entry["type"], string> = { CHARGE: "충전", GRANT: "무상 지급", DEBIT: "차감", REFUND: "환불" };
const STATUS: Record<Entry["status"], string> = { PENDING: "처리 중", SUCCEEDED: "", REVERSED: "복원" };
const stamp = (iso: string) =>
  new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
const day = (iso: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" }).format(new Date(iso));
const signed = (n: number) => (n > 0 ? `+${won(n)}` : n < 0 ? `−${won(Math.abs(n))}` : won(0));

export default function MessageBalancePage() {
  const [state, setState] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; b: Balance }>({ kind: "loading" });
  const [ledger, setLedger] = useState<Ledger>({ kind: "loading" });
  const [more, setMore] = useState(false);
  const [threshold, setThreshold] = useState("");
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [showError, setShowError] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [amountError, setAmountError] = useState<string | null>(null);
  const [confirmAmount, setConfirmAmount] = useState<number | null>(null);
  const [pending, setPending] = useState(false);
  // 같은 금액의 확인 중(202) 결제는 같은 키로 다시 보내 결과를 확인한다. 결과가 정해지면 키를 버린다.
  const attempt = useRef<{ amount: number; key: string } | null>(null);

  const load = useCallback(async () => {
    const r = await api<Balance>("/api/seller/message-balance");
    if (!r.ok) return setState({ kind: "error", status: r.status });
    setThreshold(String(r.data.lowBalanceThreshold));
    setState({ kind: "ok", b: r.data });
  }, []);
  const loadLedger = useCallback(async () => {
    const r = await api<{ entries: Entry[]; nextCursor: string | null }>("/api/seller/message-balance/ledger?limit=50");
    setLedger(r.ok ? { kind: "ok", entries: r.data.entries, next: r.data.nextCursor } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => {
    void load();
    void loadLedger();
  }, [load, loadLedger]);

  const loadMore = async () => {
    if (ledger.kind !== "ok" || !ledger.next) return;
    setMore(true);
    const r = await api<{ entries: Entry[]; nextCursor: string | null }>(`/api/seller/message-balance/ledger?limit=50&cursor=${encodeURIComponent(ledger.next)}`);
    setMore(false);
    if (r.ok) setLedger({ kind: "ok", entries: [...ledger.entries, ...r.data.entries], next: r.data.nextCursor });
    else setToast("사용 내역을 더 불러오지 못했습니다. 다시 눌러 주십시오");
  };

  if (state.kind !== "ok") {
    return (
      <>
        <Topbar crumb="설정 › 쇼핑몰 설정 › 발송·이용 충전" />
        <main className="main">
          <PageHead title="발송·이용 충전" />
          <div className="card">
            {state.kind === "loading" && <LoadingRows rows={5} />}
            {state.kind === "error" &&
              (state.status === 403 ? <NoPermission need="대표자" /> : state.status === 402 ? <Locked /> : <ErrorState title="발송·이용 충전 정보를 불러오지 못했습니다" onRetry={() => void load()} />)}
          </div>
        </main>
      </>
    );
  }

  const b = state.b;
  const price = (c: Channel) => b.prices.find((p) => p.channel === c);
  // 단가는 마스터 관리자가 정한다. 충전 기능이 꺼져 있고 0원이면 아직 정해지지 않은 값이다.
  const priceText = (c: Channel) => {
    const p = price(c);
    return !p || (!b.chargingEnabled && p.unitPrice === 0) ? TBD : String(p.unitPrice.toLocaleString("ko-KR"));
  };
  const fill = (s: string) =>
    s
      .replace(/`/g, "")
      .replace(/\{\{월 거래 메일 제공량\}\}/g, String(b.mail.quota.toLocaleString("ko-KR")))
      .replace(/\{\{거래 메일 단가\}\}/g, priceText("MAIL_TRANSACTIONAL"))
      .replace(/\{\{대량 메일 단가\}\}/g, priceText("MAIL_BULK"))
      .replace(/\{\{문자 단가\}\}/g, priceText("SMS"))
      .replace(/\{\{LMS 단가\}\}/g, priceText("LMS"))
      .replace(/\{\{알림톡 단가\}\}/g, priceText("ALIMTALK"))
      .replace(/\{\{본인인증 단가\}\}/g, priceText("IDENTITY_VERIFICATION"))
      .replace(/\{\{배송 조회 단가\}\}/g, priceText("DELIVERY_TRACKING"))
      .replace(/\{\{잔액 부족 알림 기준\}\}/g, b.lowBalanceThreshold > 0 ? b.lowBalanceThreshold.toLocaleString("ko-KR") : TBD)
      .replace(/\{\{[^}]+\}\}/g, TBD);
  const rows: [string, string, string][] = [
    ["주문·배송 안내 메일(거래 메일)", "구독 플랜에 포함", fill("플랜별 월 제공량 {{월 거래 메일 제공량}}통까지 무료입니다. 남은 제공량은 다음 달로 넘어가지 않습니다.")],
    ["제공량을 넘은 거래 메일", "발송·이용 충전금에서 차감", fill("1통당 {{거래 메일 단가}}원")],
    ["광고·공지 대량 메일", "발송·이용 충전금에서 차감", fill("1통당 {{대량 메일 단가}}원")],
    ["문자(SMS·LMS)", "발송·이용 충전금에서 차감", fill("1건당 {{문자 단가}}원(긴 문자는 {{LMS 단가}}원)")],
    ["알림톡", "발송·이용 충전금에서 차감", fill("1건당 {{알림톡 단가}}원")],
    [
      "구매자 휴대폰 본인인증",
      "발송·이용 충전금에서 차감",
      fill("쇼핑몰 가입·찾기에서 본인인증을 켠 경우 1건당 {{본인인증 단가}}원. 끄면 비용이 없습니다. 인증에 실패한 건은 차감하지 않습니다."),
    ],
    [
      "배송 자동 조회",
      "발송·이용 충전금에서 차감",
      fill("「배송 완료 자동 처리」를 켠 경우 송장 1건 조회당 {{배송 조회 단가}}원. 끄면 구매자에게 택배사 조회 페이지 링크만 보여 드리며 비용이 없습니다."),
    ],
    ["송장 발급·송장 라벨 API", "발송·이용 충전금에서 차감", "외부 업체가 건당 요금을 받는 경우에만 건당 차감합니다. 송장번호 직접 입력과 송장 관리 화면은 비용이 없습니다."],
    ["현금영수증·전자세금계산서 API", "발송·이용 충전금에서 차감", "외부 업체가 건당 요금을 받는 경우에만 건당 차감합니다."],
  ];

  const consented = !!b.consent;
  const thresholdNum = parseAmount(threshold);
  const thresholdError = thresholdNum === null ? "숫자만 입력해 주십시오" : thresholdNum > MAX_THRESHOLD ? `${won(MAX_THRESHOLD)}까지 정할 수 있습니다` : null;
  // 틀린 값이어도 누르면 이유를 보이도록, 저장된 값과 다르기만 하면 켠다
  const thresholdDirty = threshold.trim() !== String(b.lowBalanceThreshold);

  const saveThreshold = async () => {
    if (thresholdError || thresholdNum === null) return setShowError(true);
    setBusy(true);
    setFailure(null);
    const r = await api<unknown>("/api/seller/message-balance", { method: "PUT", body: { lowBalanceThreshold: thresholdNum } });
    setBusy(false);
    if (!r.ok) return setFailure(failMessage(r, "admin", "저장하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
    setShowError(false);
    setToast("잔액 부족 알림 기준을 저장했습니다");
    await load();
  };
  const consent = async () => {
    setBusy(true);
    setFailure(null);
    const r = await api<unknown>("/api/seller/message-balance/consent", { method: "POST", body: { version: b.noticeVersion } });
    setBusy(false);
    if (!r.ok) {
      setAgree(false);
      setFailure(r.status === 409 ? "안내 내용이 바뀌었습니다. 새로 고친 뒤 다시 확인해 주십시오" : failMessage(r, "admin", "동의를 저장하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
      if (r.status === 409) await load();
      return;
    }
    setToast("발송 비용 안내 동의를 저장했습니다");
    await load();
  };

  const openCharge = () => {
    const n = parseAmount(amount);
    const bad = n === null || n < CHARGE_MIN || n > CHARGE_MAX || n % CHARGE_UNIT !== 0;
    setFailure(null);
    if (bad) return setAmountError("충전 금액은 1,000원에서 100만 원 사이, 1,000원 단위로 입력해 주십시오");
    setAmountError(null);
    setConfirmAmount(n);
  };
  const charge = async () => {
    if (confirmAmount === null) return;
    if (attempt.current?.amount !== confirmAmount) attempt.current = { amount: confirmAmount, key: crypto.randomUUID() };
    setBusy(true);
    const r = await api<{ charge: { status: "PAID" | "PENDING" | "FAILED" } }>("/api/seller/message-balance/charges", {
      method: "POST",
      body: { amount: confirmAmount, idempotencyKey: attempt.current.key },
    });
    setBusy(false);
    if (r.ok && r.status === 202) {
      setPending(true);
      setConfirmAmount(null);
      return setFailure("결제 결과를 확인하고 있습니다. 잠시 뒤 「충전하기」를 다시 눌러 같은 금액으로 결과를 확인해 주십시오");
    }
    if (r.ok) {
      attempt.current = null;
      setPending(false);
      setConfirmAmount(null);
      setAmount("");
      setToast(`${won(confirmAmount)}을 충전했습니다`);
      await Promise.all([load(), loadLedger()]);
      return;
    }
    setConfirmAmount(null);
    if (r.status === 402) {
      attempt.current = null;
      setPending(false);
    }
    if (r.status === 409 && r.error === "consent_required") await load();
    setFailure(failMessage(r, "admin", "충전하지 못했습니다. 잠시 후 다시 시도해 주십시오"));
  };

  const upcoming = b.prices.filter((p) => p.next);

  return (
    <>
      <Topbar crumb="설정 › 쇼핑몰 설정 › 발송·이용 충전" />
      <main className="main">
        <PageHead title="발송·이용 충전" />

        {!b.chargingEnabled && (
          <div className="msg msg-cau" role="note" data-testid="charging-off" style={{ marginBottom: 16 }}>
            <span>
              <b>충전 기능을 준비하고 있습니다.</b> 발송 비용 안내의 단가와 조건이 확정되고 법률 검토가 끝나면 열립니다. 지금은 잔액과 사용 내역만 볼 수 있습니다.
            </span>
          </div>
        )}
        {upcoming.map((p) => (
          <div key={p.channel} className="msg msg-info" role="note" style={{ marginBottom: 16 }}>
            <span>
              {day(p.next!.effectiveAt)}부터 {CHANNEL[p.channel]} 단가가 {won(p.next!.unitPrice)}으로 바뀝니다. 이미 충전한 잔액은 금액(원) 기준이라 사라지지 않습니다. 변경 후 발송부터 새 단가로 차감합니다.
            </span>
          </div>
        ))}
        {failure && (
          <div className="msg msg-neg" role="alert" style={{ marginBottom: 16 }}>
            <span>{failure}</span>
          </div>
        )}
        {b.lowBalance && (
          <div className="msg msg-cau" role="status" style={{ marginBottom: 16 }}>
            <span>발송·이용 충전금이 {won(b.lowBalanceThreshold)} 아래로 내려갔습니다.</span>
          </div>
        )}

        <FormSection title="잔액">
          <FormRow label="유료 잔액" help="직접 충전한 금액 · 환불 신청 가능">
            <b className="num" data-testid="paid-balance">
              {won(b.paidBalance)}
            </b>
          </FormRow>
          <FormRow label="무상 잔액" help="이벤트·보상 지급 · 환불 안 됨 · 유료를 먼저 차감">
            <b className="num" data-testid="free-balance">
              {won(b.freeBalance)}
            </b>
          </FormRow>
          <FormRow label="거래 메일 제공량" help="플랜 포함 · 이번 달 · 남은 제공량은 이월되지 않습니다">
            <b className="num" data-testid="mail-quota">
              {b.mail.sent.toLocaleString("ko-KR")} / {b.mail.quota.toLocaleString("ko-KR")}통
            </b>
          </FormRow>
          <FormRow label="잔액 부족 미발송" help="주문·배송 처리는 그대로 진행됩니다">
            <b className="num" data-testid="skipped">
              {b.mail.skippedBalance.toLocaleString("ko-KR")}건
            </b>
          </FormRow>
        </FormSection>

        <div style={{ marginTop: 32 }}>
          <FormSection title="발송 비용 안내">
            <tr>
              <td colSpan={2} style={{ padding: 0 }}>
                <div style={{ overflowX: "auto" }}>
                  <table className="tbl" data-testid="price-table">
                    <thead>
                      <tr>
                        <th>구분</th>
                        <th>비용</th>
                        <th>기준</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(([k, cost, basis]) => (
                        <tr key={k}>
                          <td>{k}</td>
                          <td>{cost}</td>
                          <td className="col-text">{basis}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </td>
            </tr>
          </FormSection>
          <ul className="help" style={{ marginTop: 8, paddingLeft: 16 }}>
            {MESSAGE_FEE_NOTICE[0].items.map((s) => (
              <li key={s}>{fill(s)}</li>
            ))}
          </ul>
        </div>

        <div style={{ marginTop: 32 }}>
          <FormSection title="충전">
            <FormRow label="충전 금액" help="선불 · 발송·이용 충전금에서만 차감합니다">
              <input
                className={`inp num${amountError ? " is-error" : ""}`}
                type="text"
                inputMode="numeric"
                placeholder="0"
                value={amount}
                disabled={!b.chargingEnabled || !consented || busy}
                readOnly={pending}
                onChange={(e) => {
                  setAmount(e.target.value);
                  setAmountError(null);
                }}
                aria-label="충전 금액"
                aria-invalid={!!amountError}
                data-testid="charge-amount"
                style={{ width: 160 }}
              />
              <span className="t-l2 c-alt">원</span>
              {amountError && <span className="err" role="alert">{amountError}</span>}
            </FormRow>
            <FormRow
              label="잔액 부족 알림 기준"
              htmlFor="threshold"
              help={showError && thresholdError ? <span className="err">{thresholdError}</span> : "잔액이 기준 아래로 내려가면 알려 드립니다 · 0원이면 알리지 않습니다 · 잔액이 모자라면 그 건은 보내지 않고 「잔액 부족 미발송」으로 기록합니다"}
            >
              <input
                id="threshold"
                className={`inp num${showError && thresholdError ? " is-error" : ""}`}
                type="text"
                inputMode="numeric"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                style={{ width: 160 }}
                aria-invalid={showError && !!thresholdError}
              />
              <span className="t-l2 c-alt">원</span>
              <button className="btn btn-sm btn-out" type="button" disabled={busy || !thresholdDirty} onClick={() => void saveThreshold()}>
                기준 저장
              </button>
            </FormRow>
            <FormRow
              label="동의"
              help={
                consented
                  ? `동의 버전 ${b.consent!.version} · ${stamp(b.consent!.consentedAt)} 저장 · 다음 충전부터는 체크를 다시 받지 않습니다(안내가 바뀌면 다시 받습니다)`
                  : "체크하지 않으면 충전할 수 없습니다 · 동의한 안내 서식의 버전과 시각을 저장합니다 · 안내 내용이 바뀌면 다음 충전 때 다시 동의를 받습니다"
              }
            >
              <label className="chk">
                <input
                  type="checkbox"
                  checked={consented || agree}
                  disabled={consented || busy || !b.chargingEnabled}
                  onChange={(e) => {
                    setAgree(e.target.checked);
                    if (e.target.checked) void consent();
                  }}
                />
                발송 비용 안내를 확인했고 동의합니다
              </label>
            </FormRow>
          </FormSection>
          <div className="row" style={{ justifyContent: "center", marginTop: 16 }}>
            <button className="btn btn-lg" type="button" disabled={!b.chargingEnabled || !consented || busy} onClick={openCharge} data-testid="charge-button">
              충전하기
            </button>
          </div>
          <p className="help" style={{ marginTop: 16 }} data-testid="charge-targets">
            차감 대상: 제공량을 넘은 거래 메일 · 대량 메일 · 문자 · 알림톡 · 구매자 본인확인 · 배송 자동조회 · 송장 발급·라벨 API · 현금영수증 API · 전자세금계산서 API. 잔액이 없으면 해당 기능만 멈추고 주문 처리는 계속됩니다. 후불 청구는 없습니다.
          </p>
          <p className="help" style={{ textAlign: "center" }}>
            {!b.chargingEnabled ? "충전 기능 준비 중" : consented ? "구독 결제 카드로 충전합니다 · 누르면 확인 창이 열립니다" : "동의에 체크하면 충전할 수 있습니다"}
          </p>
        </div>

        <details style={{ marginTop: 32 }} data-testid="notice-terms">
          <summary className="t-l1 fw6" style={{ cursor: "pointer" }}>
            발송 비용 안내 · 선불 충전 방식 · 차감 기준 · 환불 · 판매자 책임 · 단가 변경 · 동의 (2~7절)
          </summary>
          {MESSAGE_FEE_NOTICE.slice(1).map((sec) => (
            <section key={sec.n} style={{ marginTop: 16 }}>
              <h3 className="t-hl2">
                {sec.n}. {sec.title}
              </h3>
              <ol className="help" style={{ paddingLeft: 20, marginTop: 8 }}>
                {sec.items.map((s) => (
                  <li key={s}>{fill(s)}</li>
                ))}
              </ol>
            </section>
          ))}
        </details>

        <div style={{ marginTop: 32 }}>
          <FormSection title="사용 내역">
            <tr>
              <td colSpan={2} style={{ padding: 0 }}>
                {ledger.kind === "loading" && <LoadingRows rows={4} />}
                {ledger.kind === "error" && <ErrorState title="사용 내역을 불러오지 못했습니다" onRetry={() => void loadLedger()} />}
                {ledger.kind === "ok" &&
                  (ledger.entries.length === 0 ? (
                    <div className="st">
                      <span className="t">아직 사용 내역이 없습니다</span>
                    </div>
                  ) : (
                    <div style={{ overflowX: "auto" }}>
                      <table className="tbl" data-testid="ledger-table">
                        <thead>
                          <tr>
                            <th>일시</th>
                            <th>구분</th>
                            <th>채널 · 내용</th>
                            <th>건수</th>
                            <th>유료 잔액 변동</th>
                            <th>무상 잔액 변동</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ledger.entries.map((e) => (
                            <tr key={e.id} data-testid="ledger-row">
                              <td className="num">{stamp(e.createdAt)}</td>
                              <td>
                                {TYPE[e.type]}
                                {STATUS[e.status] ? ` · ${STATUS[e.status]}` : ""}
                              </td>
                              <td className="col-text">{[e.channel ? CHANNEL[e.channel] : null, e.reason].filter(Boolean).join(" · ") || "-"}</td>
                              <td className="num">{e.quantity === null ? "-" : `${e.quantity.toLocaleString("ko-KR")}건`}</td>
                              <td className="num">{signed(e.paidAmount)}</td>
                              <td className="num">{signed(e.freeAmount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ))}
              </td>
            </tr>
          </FormSection>
          {ledger.kind === "ok" && ledger.next && (
            <div className="row" style={{ justifyContent: "center", marginTop: 16 }}>
              <button className="btn btn-sm btn-out" type="button" onClick={() => void loadMore()} disabled={more}>
                {more ? "불러오는 중" : "더 보기"}
              </button>
            </div>
          )}
          <p className="help" style={{ marginTop: 8 }}>
            받는 사람에게 도달에 성공한 건만 차감합니다 · 실패한 건은 차감하지 않고 먼저 차감했다면 「복원」으로 되돌립니다 · 알림톡 실패 → 문자 대체는 최종 성공 채널 요금 하나만 차감합니다
          </p>
        </div>
      </main>
      {confirmAmount !== null && (
        <Modal labelId="charge-title" busy={busy} busyText="결제 중입니다. 끝날 때까지 닫을 수 없습니다." onClose={() => setConfirmAmount(null)}>
          <div className="modal-h">
            <h2 className="modal-t" id="charge-title">
              {won(confirmAmount)}을 충전하시겠습니까?
            </h2>
          </div>
          <div className="modal-b">
            <p className="t-l2">구독 결제에 등록한 카드로 바로 결제됩니다. 충전한 금액은 발송 비용 안내의 단가대로만 차감됩니다.</p>
          </div>
          <div className="modal-f">
            <button className="btn btn-out" type="button" disabled={busy} onClick={() => setConfirmAmount(null)}>
              취소
            </button>
            <button className="btn" type="button" disabled={busy} onClick={() => void charge()} data-testid="charge-confirm">
              {busy ? "결제 중" : "충전"}
            </button>
          </div>
        </Modal>
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}
