"use client";

import { useCallback, useEffect, useState } from "react";
import { FormFoot, PageHead } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { api, failMessage } from "../../../../../../components/seller/api";
import { won } from "../../../../../../components/seller/format";
import { formatDate } from "../../../../../../lib/client/format";
import { useUnsavedGuard } from "../../../../../../lib/client/navigation";
import "../../../../../../styles/seller-settings2.css";

// SA-005 쇼핑몰 통합으로 바꾸기(대표자 전용). 오버레이 전용 → 쇼핑몰 통합(사업자·정산 정보 입력 뒤 차액만 결제),
// 쇼핑몰 통합 → 오버레이 전용(다음 결제일부터, 신청·취소).
// API: GET·PUT /api/seller/integration-profile, POST …/business-check, GET /api/seller/subscription, GET …/plan/preview, POST …/plan, GET /api/plans.
// 차액은 서버 미리보기(chargeNow)와 POST의 expectedAmount로 맞춘다. 금액을 화면에서 계산하지 않는다.

type View = {
  plan: { code: string; name: string } | null;
  subscription: { currentPeriodEnd: string | null; nextChargeAt: string | null; pendingPlanCode: string | null; cancelAtPeriodEnd: boolean } | null;
};
type Profile = {
  business: { companyName: string; representativeName: string; businessNumber: string; mailOrderNumber: string | null; businessAddress: string };
  settlement: { bankName: string; accountNumberMasked: string; accountHolder: string } | null;
  complete: boolean;
  businessCheck: { status: "ok" | "unchecked" | "not_active"; checkedAt: string | null };
};
type PlanRow = { planCode: string; name: string; current: boolean; price: number; change: { ok: true; applied: string; chargeNow: number; remainingDays: number | null; effectiveAt: string | null } | { ok: false; reason: string } };
type Preview = { currentPlanCode: string | null; pendingPlanCode: string | null; plans: PlanRow[] };
type PublicPlans = { plans: { code: string; listPrice: number; salePrice: number }[] };
type Form = { companyName: string; representativeName: string; businessNumber: string; mailOrderNumber: string; businessAddress: string; bankName: string; accountNumber: string; accountHolder: string; openedOn: string };
type Check = "idle" | "busy" | "ok" | "not_active";

const BANKS = ["국민은행", "신한은행", "우리은행", "하나은행", "농협", "카카오뱅크"];
const INTEGRATED = new Set(["INTEGRATED", "STANDARD"]);
const FAIL: Record<string, string> = {
  invalid_profile: "사업자·정산 정보를 다시 확인해 주십시오",
  invalid_business_number: "사업자등록번호가 올바르지 않습니다",
  invalid_account_number: "계좌번호는 숫자 8~20자리로 입력해 주십시오",
  holder_mismatch: "예금주는 상호 또는 대표자명과 같아야 합니다",
  opened_on_required: "개업일자를 입력해 주십시오",
  invalid_opened_on: "개업일자를 다시 확인해 주십시오",
  daily_limit_exceeded: "오늘 사업자 조회 횟수를 모두 사용했습니다. 내일 다시 시도해 주십시오",
  lookup_failed: "사업자 조회에 실패했습니다. 잠시 뒤 다시 시도해 주십시오",
  secret_missing: "정산 정보를 안전하게 저장할 수 없습니다. 운영 담당에게 문의해 주십시오",
  profile_incomplete: "사업자·정산 정보를 모두 채워 주십시오",
  business_unchecked: "사업자등록번호를 조회해 주십시오",
  business_not_active: "영업 중인 사업자만 쇼핑몰 통합으로 바꿀 수 있습니다",
  card_required: "결제 카드를 먼저 등록해 주십시오",
  payment_in_progress: "결제를 처리하고 있습니다. 잠시 후 다시 확인해 주십시오",
  payment_failed: "차액 결제가 거절되어 이용권을 바꾸지 않았습니다. 결제 카드를 확인해 주십시오",
  not_activated: "결제는 되었지만 이용권에 반영되지 않았습니다. 문의하기로 알려 주십시오",
  cancel_scheduled: "해지 예정인 구독은 이용권을 바꿀 수 없습니다. 결제 카드를 다시 등록해 해지를 취소한 뒤 바꿔 주십시오",
  same_plan: "이미 이용 중인 이용권입니다",
};
const EMPTY: Form = { companyName: "", representativeName: "", businessNumber: "", mailOrderNumber: "", businessAddress: "", bankName: "", accountNumber: "", accountHolder: "", openedOn: "" };
const day = (iso: string | null | undefined) => (iso ? formatDate(iso, ".") : "");

export default function UpgradePage() {
  const [load, setLoad] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; view: View; preview: Preview | null; profile: Profile | null; listPrice: number | null }>({ kind: "loading" });
  const [form, setForm] = useState<Form>(EMPTY);
  const [check, setCheck] = useState<Check>("idle");
  const [checked, setChecked] = useState<string | null>(null); // 조회를 마친 사업자번호·대표자명(바뀌면 다시 조회)
  const [needOpened, setNeedOpened] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"down" | "undo" | null>(null);

  const read = useCallback(async () => {
    const [v, p, pr, pub] = await Promise.all([
      api<View>("/api/seller/subscription"),
      api<Preview>("/api/seller/subscription/plan/preview"),
      api<Profile>("/api/seller/integration-profile"),
      api<PublicPlans>("/api/plans", { authRedirect: false }),
    ]);
    if (!v.ok) return setLoad({ kind: "error", status: v.status });
    const profile = pr.ok ? pr.data : null;
    if (profile) {
      setForm((f) => ({ ...f, companyName: profile.business.companyName, representativeName: profile.business.representativeName, businessNumber: profile.business.businessNumber, mailOrderNumber: profile.business.mailOrderNumber ?? "", businessAddress: profile.business.businessAddress, bankName: profile.settlement?.bankName ?? "", accountHolder: profile.settlement?.accountHolder ?? "" }));
      if (profile.businessCheck.status === "ok") {
        setCheck("ok");
        setChecked(`${profile.business.businessNumber}|${profile.business.representativeName}`);
      }
    }
    const listPrice = pub.ok ? (pub.data.plans.find((x) => x.code === "INTEGRATED")?.listPrice ?? null) : null;
    setLoad({ kind: "ok", view: v.data, preview: p.ok ? p.data : null, profile, listPrice });
  }, []);
  useEffect(() => void read(), [read]);

  const set = (k: keyof Form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setFailure(null);
    if (k === "businessNumber" || k === "representativeName") {
      setCheck("idle");
      setChecked(null);
    }
  };
  const dirty = load.kind === "ok" && !done && (form.companyName !== "" || form.accountNumber !== "");
  useUnsavedGuard(dirty && !busy);

  const required = !!form.companyName.trim() && !!form.representativeName.trim() && !!form.businessNumber.trim() && !!form.businessAddress.trim() && !!form.bankName && !!form.accountNumber.trim() && !!form.accountHolder.trim();
  const key = `${form.businessNumber}|${form.representativeName}`;

  const lookup = async (): Promise<boolean> => {
    if (!form.businessNumber.trim() || !form.representativeName.trim()) {
      setFailure("사업자등록번호와 대표자명을 입력해 주십시오");
      return false;
    }
    setCheck("busy");
    setFailure(null);
    const r = await api<{ ok: true; status: string; valid: boolean }>("/api/seller/integration-profile/business-check", {
      method: "POST",
      body: { businessNumber: form.businessNumber, representativeName: form.representativeName, ...(form.openedOn.trim() ? { openedOn: form.openedOn.trim() } : {}) },
    });
    if (!r.ok) {
      setCheck("idle");
      if (r.error === "opened_on_required") setNeedOpened(true);
      setFailure(FAIL[r.error] ?? failMessage(r, "admin"));
      return false;
    }
    if (r.data.status !== "ACTIVE" || !r.data.valid) {
      setCheck("not_active");
      return false;
    }
    setCheck("ok");
    setChecked(key);
    return true;
  };

  const upgrade = async () => {
    if (load.kind !== "ok" || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      if (!(check === "ok" && checked === key) && !(await lookup())) return;
      const saved = await api("/api/seller/integration-profile", {
        method: "PUT",
        body: { companyName: form.companyName, representativeName: form.representativeName, businessNumber: form.businessNumber, mailOrderNumber: form.mailOrderNumber || undefined, businessAddress: form.businessAddress, bankName: form.bankName, accountNumber: form.accountNumber, accountHolder: form.accountHolder },
      });
      if (!saved.ok) return setFailure(FAIL[saved.error] ?? failMessage(saved, "admin"));
      // 저장하면 게이트가 풀려 서버가 차액을 알려 준다: 미리보기를 다시 읽는다. 화면에 보인 금액과 다르면(처음에 금액이 없던 경우 포함) 확인받고 결제하지 않는다
      const fresh = await api<Preview>("/api/seller/subscription/plan/preview");
      const target = fresh.ok ? fresh.data.plans.find((p) => p.planCode === "INTEGRATED") : undefined;
      if (!target || !target.change.ok) {
        await read();
        return setFailure(target && !target.change.ok ? (FAIL[target.change.reason] ?? "이용권을 바꿀 수 없습니다") : "차액을 확인하지 못했습니다. 잠시 뒤 다시 시도해 주십시오");
      }
      const expected = target.change.chargeNow;
      const shown = load.preview?.plans.find((p) => p.planCode === "INTEGRATED");
      const shownAmount = shown?.change.ok ? shown.change.chargeNow : null;
      if (shownAmount !== expected) {
        await read();
        return setFailure(expected > 0 ? `차액 ${won(expected)}을 지금 결제합니다. 안내의 금액을 확인한 뒤 다시 눌러 주십시오` : "안내의 내용을 확인한 뒤 다시 눌러 주십시오");
      }
      const r = await api<{ ok: true; applied: string; charged: number } | { error: string }>("/api/seller/subscription/plan", {
        method: "POST",
        body: { planCode: "INTEGRATED", expectedAmount: expected },
      });
      if (!r.ok) {
        if (r.error === "amount_changed") {
          await read();
          return setFailure("차액이 바뀌었습니다. 안내의 금액을 확인한 뒤 다시 눌러 주십시오");
        }
        return setFailure(FAIL[r.error] ?? failMessage(r, "admin"));
      }
      if ("error" in r.data) return setFailure("차액 결제 결과를 확인하고 있습니다. 확인될 때까지 지금 이용권을 그대로 씁니다");
      setDone(r.data.charged > 0 ? `쇼핑몰 통합으로 바꿨습니다 · 차액 ${won(r.data.charged)}을 결제했습니다` : "쇼핑몰 통합으로 바꿨습니다");
      window.dispatchEvent(new Event("focus"));
      await read();
    } finally {
      setBusy(false);
    }
  };

  const changeDown = async (undo: boolean) => {
    setBusy(true);
    setFailure(null);
    // 서버는 확인 금액을 꼭 받는다: 내리는 변경·예약 취소는 결제가 없어 0(미리보기 chargeNow)
    const code = undo ? "INTEGRATED" : "OVERLAY_ONLY";
    const row = load.kind === "ok" ? load.preview?.plans.find((p) => p.planCode === code) : undefined;
    const r = await api<{ ok: true }>("/api/seller/subscription/plan", { method: "POST", body: row?.change.ok ? { planCode: code, expectedAmount: row.change.chargeNow } : { planCode: code } });
    setBusy(false);
    setConfirm(null);
    if (!r.ok) return setFailure(FAIL[r.error] ?? failMessage(r, "admin"));
    setToast(undo ? "변경 신청을 취소했습니다" : "변경을 신청했습니다");
    await read();
  };

  const body = () => {
    if (load.kind === "loading") return <LoadingRows rows={6} />;
    if (load.kind === "error") return <ErrorState title="화면을 불러오지 못했습니다" onRetry={() => void read()} />;
    const { view, preview, listPrice } = load;
    const code = view.plan?.code ?? "";
    const integrated = INTEGRATED.has(code);
    const overlay = code === "OVERLAY_ONLY";
    const target = preview?.plans.find((p) => p.planCode === "INTEGRATED");
    const down = preview?.plans.find((p) => p.planCode === "OVERLAY_ONLY");
    const nextDate = day(view.subscription?.currentPeriodEnd ?? view.subscription?.nextChargeAt);
    const pendingDown = view.subscription?.pendingPlanCode === "OVERLAY_ONLY";
    const cur = preview?.plans.find((p) => p.current);

    if (done) {
      return (
        <div className="up-done" role="status">
          <span>{done}{target ? ` · ${day(nextDate)}결제부터 ${won(target.price)}` : ""}</span>
          <a className="up-done-a" href="/shop" target="_blank" rel="noreferrer">스토어 열기</a>
        </div>
      );
    }

    if (integrated) {
      return (
        <>
          {failure && <div className="msg msg-neg" role="alert"><span>{failure}</span></div>}
          <h2 className="up-st">오버레이 전용으로 바꾸기 (아래 이용권)<span className="up-nt">다음 결제일부터</span></h2>
          {pendingDown ? (
            <div className="up-pend">
              <div className="msg msg-info" role="status"><b>오버레이 전용으로 바뀔 예정입니다</b> · {nextDate}부터 · 그때까지는 쇼핑몰 통합 그대로입니다 · 이전 주문의 배송 · 환불은 바뀐 뒤에도 계속 할 수 있습니다</div>
              <button className="btn btn-out" type="button" onClick={() => setConfirm("undo")}>변경 취소</button>
            </div>
          ) : (
            <>
              <div className="card up-notes">
                <p>다음 결제일({nextDate})부터 적용됩니다 · 그때까지는 쇼핑몰 통합 그대로 쓸 수 있습니다</p>
                <p>적용되면 ONQ 스토어에서 새 주문은 받지 않습니다 · 이전 주문의 배송 · 환불 · 문의는 계속 할 수 있습니다</p>
                <p>적용 뒤 월 {won(down?.price ?? 0)}입니다 · 이번 결제 기간 요금은 돌려드리지 않습니다 · 적용 전까지는 언제든 취소할 수 있습니다</p>
              </div>
              <button className="btn btn-out up-down" type="button" onClick={() => setConfirm("down")}>오버레이 전용으로 변경 신청</button>
            </>
          )}
          {confirm && (
            <div className="dim dim-fixed" role="dialog" aria-modal="true" aria-labelledby="up-confirm-title">
              <div className="modal">
                <div className="modal-h">
                  <h2 className="t-h2" id="up-confirm-title">{confirm === "down" ? "오버레이 전용으로 바꾸시겠습니까?" : "변경을 취소하시겠습니까?"}</h2>
                  <span className="t-l2 c-alt">
                    {confirm === "down"
                      ? `${nextDate} 결제부터 오버레이 전용 월 ${won(down?.price ?? 0)}으로 바뀝니다. 그날부터 ONQ 스토어 새 주문은 받지 않고, 이전 주문의 배송 · 환불은 계속 할 수 있습니다.`
                      : `취소하면 쇼핑몰 통합 그대로 유지됩니다. 다음 결제도 ${won(cur?.price ?? 0)}입니다.`}
                  </span>
                </div>
                <div className="modal-f">
                  <button className="btn btn-out" type="button" onClick={() => setConfirm(null)} disabled={busy}>{confirm === "down" ? "취소" : "유지"}</button>
                  <button className="btn" type="button" disabled={busy} onClick={() => void changeDown(confirm === "undo")}>{confirm === "down" ? "변경 신청" : "변경 취소"}</button>
                </div>
              </div>
            </div>
          )}
        </>
      );
    }

    if (!overlay) return <div className="msg msg-info">현재 이용권에서는 바꿀 수 없습니다</div>;

    const ch = target?.change;
    const charge = ch && ch.ok ? ch.chargeNow : null;
    return (
      <form onSubmit={(e) => { e.preventDefault(); void upgrade(); }} noValidate>
        {failure && <div className="msg msg-neg" role="alert"><span>{failure}</span></div>}
        <div className="msg msg-info">오버레이 전용에서는 받지 않았던 정보입니다 · 실제 판매 · 결제 · 정산을 켤 때 필요합니다</div>
        <h2 className="up-st">이용권 전환<span className="up-nt">바로 적용 · 차액만 결제</span></h2>
        <div className="card up-now">
          <div><div className="k up-nt">지금</div><b>{view.plan?.name} · {won(cur?.price ?? 0)}</b></div>
          <span className="up-arrow" aria-hidden="true">→</span>
          <div>
            <div className="k up-nt">지금부터</div>
            <b className="up-to">쇼핑몰 통합 · {won(target?.price ?? 0)}</b>
            {listPrice && target && listPrice > target.price && <span className="up-nt"> (런칭 할인가 · 정가 {won(listPrice)})</span>}
          </div>
        </div>
        <p className="up-expl up-nt">
          바꾸면 바로 적용됩니다 · {charge ? `이번 결제 기간에 남은 ${ch && ch.ok ? ch.remainingDays : ""}일 차액 ${won(charge)}을 지금 결제하고, ` : ""}
          {nextDate}부터 월 {won(target?.price ?? 0)}입니다 · 오버레이와 외부 쇼핑몰 연결은 그대로 유지됩니다
        </p>
        <section className="up-sec"><h2 className="up-st">사업자 정보</h2>
          <div className="up-grid" role="group" aria-label="사업자 정보">
            <Fld label="상호" req id="up-company"><input id="up-company" className="inp" value={form.companyName} onChange={(e) => set("companyName", e.target.value)} placeholder="사업자등록증의 상호" maxLength={60} autoComplete="off" /></Fld>
            <Fld label="대표자명" req id="up-rep"><input id="up-rep" className="inp" value={form.representativeName} onChange={(e) => set("representativeName", e.target.value)} placeholder="대표자 이름" maxLength={30} autoComplete="off" /></Fld>
            <Fld label="사업자등록번호" req id="up-bn" help={check === "not_active" ? undefined : "국세청 상태를 확인합니다 · 휴업 · 폐업이면 전환할 수 없습니다"} err={check === "not_active" ? "휴업 상태로 조회됩니다 · 영업 중인 사업자만 통합으로 바꿀 수 있습니다" : undefined}>
              <div className="up-bn">
                <input id="up-bn" className={`inp${check === "not_active" ? " is-err" : ""}`} value={form.businessNumber} onChange={(e) => set("businessNumber", e.target.value)} placeholder="000-00-00000" inputMode="numeric" autoComplete="off" />
                <button className="btn btn-out" type="button" onClick={() => void lookup()} disabled={check === "busy" || busy}>{check === "busy" ? "조회 중" : check === "ok" ? "조회됨" : "조회"}</button>
              </div>
            </Fld>
            <Fld label="통신판매업 신고번호" id="up-mo" help="쇼핑몰 하단 법정 표기에 씁니다"><input id="up-mo" className="inp" value={form.mailOrderNumber} onChange={(e) => set("mailOrderNumber", e.target.value)} placeholder="통신판매업 신고번호" autoComplete="off" /></Fld>
            {needOpened && <Fld label="개업일자" req id="up-open" help="국세청 조회에 필요합니다"><input id="up-open" className="inp" value={form.openedOn} onChange={(e) => set("openedOn", e.target.value)} placeholder="2020-01-31" inputMode="numeric" autoComplete="off" /></Fld>}
            <Fld label="사업장 주소" req id="up-addr" wide><input id="up-addr" className="inp" value={form.businessAddress} onChange={(e) => set("businessAddress", e.target.value)} placeholder="주소 검색" maxLength={200} autoComplete="off" /></Fld>
          </div>
        </section>
        <section className="up-sec"><h2 className="up-st">정산 계좌</h2>
          <div className="up-grid up-settlement" role="group" aria-label="정산 계좌">
            <Fld label="은행" req id="up-bank" help="은행을 골라 주십시오">
              <select id="up-bank" className="inp" value={form.bankName} onChange={(e) => set("bankName", e.target.value)}>
                <option value="">은행 선택</option>
                {BANKS.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </Fld>
            <Fld label="계좌번호" req id="up-acc"><input id="up-acc" className="inp" value={form.accountNumber} onChange={(e) => set("accountNumber", e.target.value)} placeholder="숫자만" inputMode="numeric" autoComplete="off" /></Fld>
            <Fld label="예금주" req id="up-holder" help="예금주가 상호 또는 대표자명과 같아야 합니다"><input id="up-holder" className="inp" value={form.accountHolder} onChange={(e) => set("accountHolder", e.target.value)} placeholder="예금주 이름" maxLength={30} autoComplete="off" /></Fld>
          </div>
        </section>
        <div className="card up-pay">구매자 결제는 ONQ 결제대행사로 받습니다 · 이 계좌는 정산 · 환불 확인에 씁니다</div>
        <FormFoot>
          <button className="btn btn-lg" type="submit" disabled={!required || busy}>{busy ? "바꾸는 중" : "쇼핑몰 통합으로 바꾸기"}</button>
          <a className="btn btn-lg btn-out" href="/seller/subscription">나중에 하기</a>
        </FormFoot>
        {!required && <p className="help up-hint">필수 항목을 모두 채우면 버튼이 켜집니다</p>}
      </form>
    );
  };

  return (
    <>
      <Topbar crumb="설정 › 쇼핑몰 통합 전환 › 쇼핑몰 통합으로 바꾸기" />
      <main className="main">
        <PageHead title="쇼핑몰 통합으로 바꾸기" actions={<a className="btn btn-out" href="/seller/subscription">구독 · 결제</a>} />
        {body()}
      </main>
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </>
  );
}

function Fld({ label, req, id, help, err, wide, children }: { label: string; req?: boolean; id: string; help?: string; err?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={`fld${wide ? " wide" : ""}`}>
      <label htmlFor={id}><span className={req ? "req" : undefined}>{label}</span></label>
      {children}
      {err ? <p className="err" role="alert">{err}</p> : help ? <p className="help">{help}</p> : null}
    </div>
  );
}
