"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { DatePicker, TimePicker, FormFoot, FormRow, FormSection, PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { addDays, todayKst } from "../../../../../../lib/client/dateInput";
import { formatDateTime } from "../../../../../../lib/client/format";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";
import { adminApi } from "../../../_components/api";
import { effectiveAtIso } from "../../../_components/messageFees";
import styles from "./page.module.css";

type Created = { sellerId: string; trialEndsAt: string; invite: { path: string; url: string | null; expiresAt: string } };
type Plan = { code: string; name: string };

// MA-017 FINAL(2026-10-26). 기존 직접 추가 API만 사용하며 초대 링크는 현재 화면 메모리에만 둔다.
export default function NewPartnerPage() {
  const { me } = useAdmin();
  const allowed = adminCan(me.role, "system.manage");
  const { confirm } = useConfirm();
  const sending = useRef(false);
  const [shopName, setShopName] = useState("");
  const [slug, setSlug] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [reason, setReason] = useState("");
  const [customPlan, setCustomPlan] = useState(false);
  const [planCode, setPlanCode] = useState("INTEGRATED");
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [customTrial, setCustomTrial] = useState(false);
  const [trialDate, setTrialDate] = useState(() => addDays(todayKst(), 7));
  const [trialTime, setTrialTime] = useState("");
  const [slugNotice, setSlugNotice] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let alive = true;
    void adminApi<{ plans: Plan[] }>("/api/admin/plans").then((r) => {
      if (alive) setPlans(r.ok ? r.data.plans.filter((p) => p.code === "INTEGRATED" || p.code === "OVERLAY_ONLY") : []);
    });
    return () => { alive = false; };
  }, [allowed]);

  const trialIso = customTrial && trialDate && trialTime ? effectiveAtIso(`${trialDate}T${trialTime}`) : undefined;
  const timeError = customTrial && (!trialTime ? "체험 종료 시각(KST)을 선택해 주십시오" : !trialIso || new Date(trialIso).getTime() <= Date.now() ? "체험 종료일은 지금보다 뒤여야 합니다" : null);
  const ready = !!shopName.trim() && !!slug.trim() && !!ownerName.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail.trim()) && !!reason.trim() && !timeError && (!customPlan || !!plans?.some((p) => p.code === planCode));
  const checkSlug = async () => {
    if (!slug.trim() || checking) return;
    const checkedSlug = slug.trim();
    setChecking(true);
    const r = await adminApi<{ available: boolean; reason: "invalid" | "taken" | null }>(`/api/seller-signup/slug-check?slug=${encodeURIComponent(checkedSlug)}`);
    setChecking(false);
    // 확인 도중 주소를 바꾸지 못하게 해 다른 주소의 결과를 표시하지 않는다.
    setSlugNotice(!r.ok ? "주소를 확인하지 못했습니다. 다시 눌러 주십시오" : r.data.available ? "쓸 수 있는 주소입니다. 만들 때 다시 확인합니다" : r.data.reason === "taken" ? "이미 쓰는 쇼핑몰 주소입니다 · 다른 주소를 입력해 주십시오" : "3~30자 · 영문 소문자 · 숫자 · 하이픈만 쓸 수 있고 예약어는 쓸 수 없습니다");
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!allowed || !ready || sending.current) return;
    sending.current = true;
    setBusy(true);
    setNotice(null);
    const ok = await confirm({
      title: `「${shopName.trim()}」 파트너스를 만드시겠습니까?`, confirmLabel: "파트너스 만들기",
      body: <>{`주소 /shop/${slug.trim()} · ${customPlan ? plans?.find((p) => p.code === planCode)?.name : "기본 요금제"} · 체험 종료 ${trialIso ? `${formatDateTime(trialIso)} KST` : "지금부터 7일"} · 대표자 ${ownerName.trim()} · 로그인 이메일 ${ownerEmail.trim()}`}<br />본인확인 대기로 만들어지고 초대 링크는 한 번만 보여 드립니다 · 만든 사실과 사유는 로그 추적에 남습니다.</>,
    });
    if (!ok) { sending.current = false; setBusy(false); return; }
    const r = await adminApi<Created>("/api/admin/sellers/direct-create", {
      method: "POST", json: { shopName: shopName.trim(), slug: slug.trim(), ownerName: ownerName.trim(), ownerEmail: ownerEmail.trim(), reason: reason.trim(), ...(customPlan ? { planCode } : {}), ...(trialIso ? { trialEndsAt: trialIso } : {}) },
    });
    sending.current = false;
    setBusy(false);
    if (r.ok) { setCreated(r.data); return; }
    setNotice(r.status === 0 || r.status >= 500
      ? "결과를 확인하지 못했습니다. 입력한 내용은 그대로 있습니다. 목록에서 같은 주소의 파트너스가 만들어졌는지 먼저 확인해 주십시오"
      : r.message ?? "파트너스를 만들지 못했습니다. 입력한 내용을 확인한 뒤 다시 눌러 주십시오");
  };

  const inviteUrl = created ? created.invite.url ?? (typeof window === "undefined" ? created.invite.path : new URL(created.invite.path, window.location.origin).href) : "";
  const copyInvite = async () => {
    try { await navigator.clipboard.writeText(inviteUrl); setCopied("복사했습니다"); }
    catch { setCopied("복사하지 못했습니다. 초대 링크를 직접 선택해 복사해 주십시오"); }
  };

  return <>
    <AdminTopbar crumb="파트너스 › 파트너스 목록 › 파트너스 직접 추가" />
    <main className={`main ${styles.page}`}>
      <PageHead title="파트너스 직접 추가" back="/admin/partners" actions={<Link className="btn btn-out" href="/admin/partners">목록으로</Link>} />
      {!allowed ? <div className="msg msg-info" role="status">최고관리자만 할 수 있습니다</div> : created ? <section className={styles.result}>
        <div className="msg msg-pos" role="status" style={{ display: "block" }}><b>「{shopName.trim()}」 파트너스를 만들었습니다.</b> 본인확인 대기 · 체험 종료 {formatDateTime(created.trialEndsAt)} KST · 대표자가 아래 초대 링크에서 비밀번호를 정하고 본인확인을 마칩니다</div>
        <div className={styles.invite}>
          <p>초대 링크 · 이 창을 닫으면 다시 볼 수 없습니다 · 다시 필요하면 파트너스 상세에서 재발급합니다(이전 링크는 무효)</p>
          <div className="row" style={{ gap: 8 }}><span className={styles.link} data-testid="created-invite-link">{inviteUrl}</span><button className="btn btn-sm btn-out" type="button" onClick={() => void copyInvite()}>복사</button></div>
          <p>만료 {formatDateTime(created.invite.expiresAt)} KST · 72시간 안에 한 번만 쓸 수 있습니다 · 메일은 보내지 않습니다 · 대표자에게 직접 전달해 주십시오 · 로그인 이메일 {ownerEmail.trim()}</p>
          {copied && <span role="status">{copied}</span>}
        </div>
        <div className="row" style={{ gap: 8 }}><Link className="btn btn-sm" href={`/admin/partners/${created.sellerId}`}>파트너스 상세</Link><Link className="btn btn-sm btn-out" href="/admin/partners">목록으로</Link></div>
      </section> : <>
        <div className="msg msg-info" style={{ display: "block" }}>가입 신청 없이 첫 파트너스 계정을 만듭니다 · 최고관리자만 할 수 있습니다 · 만든 계정은 「본인확인 대기」로 표시됩니다 · 대표자는 초대 링크(72시간 · 1회용)에서 비밀번호를 직접 정합니다 · 메일은 보내지 않습니다 · 만든 사실과 사유는 로그 추적에 남습니다</div>
        {notice && <div className="msg msg-neg" role="alert" style={{ display: "block" }}>{notice}</div>}
        <form onSubmit={submit}>
          <fieldset disabled={busy} className={styles.fields}>
            <FormSection title="파트너스 정보">
              <FormRow label="쇼핑몰 이름" htmlFor="direct-shop" required help="50자까지 · 파트너스 관리자 · 구매자 쇼핑몰에 보이는 이름 · 나중에 파트너스가 바꿀 수 있습니다"><input id="direct-shop" className="inp inp-w-lg" maxLength={50} required value={shopName} onChange={(e) => setShopName(e.target.value)} placeholder="쇼핑몰 이름 입력" /></FormRow>
              <FormRow label="쇼핑몰 주소" htmlFor="direct-slug" required help="3~30자 · 영문 소문자 · 숫자 · 하이픈 · 예약어는 쓸 수 없습니다 · 만든 뒤에는 바꿀 수 없습니다 · 쇼핑몰 경로 /shop/입력한주소">
                <input id="direct-slug" className="inp inp-w-md" minLength={3} maxLength={30} pattern="[a-z0-9-]{3,30}" required disabled={checking} value={slug} onChange={(e) => { setSlug(e.target.value); setSlugNotice(null); }} placeholder="영문 소문자 · 숫자 · -" />
                <button className="btn btn-sm btn-out" type="button" disabled={!slug.trim() || checking} onClick={() => void checkSlug()}>중복 확인</button>{slugNotice && <span className="help" role="status">{slugNotice}</span>}
              </FormRow>
              <FormRow label="이용권" required help="기본값은 쇼핑몰 통합(서버 기본 요금제) · 직접 선택하면 현재 요금제 목록에서 고릅니다">
                <label className="chk"><input className="rdo" type="radio" name="direct-plan" checked={!customPlan} onChange={() => setCustomPlan(false)} />기본 요금제 사용</label>
                <label className="chk"><input className="rdo" type="radio" name="direct-plan" checked={customPlan} onChange={() => setCustomPlan(true)} />직접 선택</label>
                <select className="inp inp-w-md" aria-label="이용권 선택" disabled={!customPlan || !plans?.length} value={planCode} onChange={(e) => setPlanCode(e.target.value)}><option value="INTEGRATED">{plans?.find((p) => p.code === "INTEGRATED")?.name ?? "쇼핑몰 통합"}</option>{plans?.filter((p) => p.code !== "INTEGRATED").map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</select>
                {customPlan && plans?.length === 0 && <span role="alert" className="err">요금제를 불러오지 못했습니다. 기본 요금제를 쓰거나 다시 열어 주십시오</span>}
              </FormRow>
              <FormRow label="체험 종료일" required help="기본 지금부터 7일 · 직접 고를 때는 날짜와 시각(KST)을 모두 선택합니다 · 지금보다 뒤만 · 변경 시 사유 필수 · 상한 없음 · 최고관리자만 변경">
                <DatePicker aria-label="체험 종료 날짜" value={trialDate} onChange={(v) => { setTrialDate(v); setCustomTrial(!!v); }} />
                <TimePicker aria-label="체험 종료 시각(KST)" value={trialTime} disabled={!customTrial} onChange={setTrialTime} />
                <span className="help">{customTrial ? "직접 선택한 날짜 · 시각" : "기본 지금부터 7일"}</span>
                {timeError && <span className="err" role="alert">{timeError}</span>}
              </FormRow>
              <FormRow label="사업자 정보" help="비워 두면 자동 점검을 건너뜁니다 · 쇼핑몰 통합은 사업자 · 정산 정보가 있어야 결제를 받을 수 있습니다">
                <label className="chk"><input className="rdo" type="radio" checked readOnly />나중에 파트너스가 입력</label><label className="chk"><input className="rdo" type="radio" disabled />지금 입력</label><span className="help">지금 입력은 아직 지원하지 않습니다</span>
              </FormRow>
            </FormSection>
            <FormSection title="대표자 계정">
              <FormRow label="대표자 이름" htmlFor="direct-owner" required help="30자까지"><input id="direct-owner" className="inp inp-w-md" maxLength={30} required value={ownerName} onChange={(e) => setOwnerName(e.target.value)} placeholder="이름 입력" /></FormRow>
              <FormRow label="로그인 이메일" htmlFor="direct-email" required help="파트너스 관리자 로그인 아이디 · 같은 쇼핑몰 안에서 중복될 수 없습니다"><input id="direct-email" className="inp inp-w-lg" type="email" maxLength={254} required value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} placeholder="이메일 입력" /></FormRow>
              <FormRow label="휴대폰" htmlFor="direct-phone" help="선택 · 비워 두면 자동 점검을 건너뜁니다 · 직접 추가할 때 휴대폰 입력은 아직 지원하지 않습니다"><input id="direct-phone" className="inp inp-w-md" disabled placeholder="숫자만 입력" /></FormRow>
              <FormRow label="초대 링크" help="72시간 안에 한 번만 쓸 수 있습니다 · 대표자가 링크에서 비밀번호를 직접 정합니다 · 메일은 보내지 않습니다 · 재발급하면 이전 링크는 쓸 수 없습니다"><span className="bdg b-gray">만든 뒤 1회 표시</span></FormRow>
              <FormRow label="본인확인" help="대표자 본인확인 전 직원 추가 · 적립금 실제 지급 · 충전금 결제 · 아이디 · 비밀번호 찾기가 막힙니다"><span className="bdg b-warn">대기</span></FormRow>
              <FormRow label="사유" htmlFor="direct-reason" required help="1~200자 · 로그 추적에 남습니다"><textarea id="direct-reason" className="inp" rows={2} maxLength={200} required value={reason} onChange={(e) => setReason(e.target.value)} placeholder="사유 입력" /></FormRow>
            </FormSection>
          </fieldset>
          <FormFoot><button className="btn btn-lg" type="submit" disabled={!ready || busy}>{busy ? "처리 중" : "파트너스 만들기"}</button><Link className="btn btn-lg btn-out" href="/admin/partners">취소</Link></FormFoot>
        </form>
      </>}
    </main>
  </>;
}
