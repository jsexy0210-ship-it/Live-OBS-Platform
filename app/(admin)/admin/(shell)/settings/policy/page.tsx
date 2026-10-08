"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { adminCan } from "../../../../../../lib/server/authz/permissions";
import { FormRow, FormSection, PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows, Toast } from "../../../../../../components/seller/States";
import { adminApi, failMessage } from "../../../_components/api";
import { AdminTopbar, useAdmin } from "../../../_components/AdminShell";

// MA-081 플랫폼 기본 정책(GET·PATCH /api/admin/settings/policy). 정본: design/project/MA-081.dc.html(FINAL v293).
// 보기는 모든 마스터 역할, 바꾸기는 최고관리자만(system.manage). 저장은 확인 창(바뀐 항목 요약)을 거치고 바뀐 키만 서버에 보낸다(로그 추적 platform.policy.update).
// applied=false인 값은 서버가 저장만 하고 기능이 아직 읽지 않으므로 「적용 예정」으로 표시한다. 서버에 없는 값(약관 버전·강제 항목·실제 지급 기본값)은 「준비 중」.
type Value = number | boolean;
type Item = { key: string; group: string; kind: "int" | "bool" | "enum"; unit: string; value: Value; default: Value; min?: number; max?: number; options?: number[]; applied: boolean };
type Policy = { plans: { code: string; name: string; trialDays: number }[]; policy: Item[] };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Policy };

const UNIT: Record<string, string> = { hours: "시간", days: "일", times: "회", seconds: "초", percent: "%", won: "원", minutes: "분" };
// 정본의 선택지 순서와 문구
const ENUM_ORDER: Record<string, number[]> = { reviewTargetHours: [48, 24, 72], supplementAutoRejectDays: [7, 3, 0], dataRetentionDays: [90, 180] };
const ENUM_LABEL: Record<string, (v: number) => string> = {
  reviewTargetHours: (v) => (v === 48 ? "48시간 (초과 시 알림)" : `${v}시간`),
  supplementAutoRejectDays: (v) => (v === 0 ? "안 함" : `${v}일`),
  dataRetentionDays: (v) => `${v}일`,
};
const SUFFIX: Record<string, { unit: string; hint?: string }> = {
  paymentRetryCount: { unit: "회 · 하루 간격 (고정)" },
  overdueLockDays: { unit: "일", hint: "실패한 날부터 유예 · 그 뒤 쇼핑몰 · 방송 화면 멈춤" },
  lockToCloseDays: { unit: "일" },
  priceNoticeDays: { unit: "일 · 법정 최소 30일 · 줄일 수 없음" },
  openTimerSeconds: { unit: "초", hint: "파트너스가 바꿀 수 있습니다" },
  overlayReconnectMax: { unit: "회", hint: "초과 시 알림" },
  hitSeconds: { unit: "초 기본" },
  maxEarnRatePercent: { unit: "%" },
  maxUseRatioPercent: { unit: "%" },
  rewardBalanceWarnPercent: { unit: "% 초과 시 주의" },
  manualGrantMax: { unit: "원", hint: "초과 시 알림" },
  adminSessionHours: { unit: "시간" },
  adminIdleMinutes: { unit: "분" },
  impersonationMinutes: { unit: "분 · 최대 60" },
};
const BOOL_LABEL: Record<string, string> = {
  bizStatusAutoCheck: "국세청 사업자 상태 자동 조회",
  duplicateSignupBlock: "동일 사업자번호 · 연락처 중복 가입 차단",
  reconsentOnNewLegalVersion: "새 버전 게시 시 파트너스 재동의 요구",
};
const NAME: Record<string, string> = {
  reviewTargetHours: "가입 심사 목표 시간",
  supplementAutoRejectDays: "보완 요청 무응답 자동 반려",
  paymentRetryCount: "결제 실패 재시도",
  overdueLockDays: "연체 → 잠금",
  lockToCloseDays: "잠금 → 해지",
  dataRetentionDays: "해지 후 데이터 보관",
  priceNoticeDays: "요금 변경 사전 고지",
  openTimerSeconds: "기본 오픈 타이머",
  overlayReconnectMax: "방송 화면 재연결 최대",
  hitSeconds: "HIT 연출 노출",
  carryOverAlways: "방송 종료 후 대기 주문 이월",
  maxEarnRatePercent: "최대 적립률",
  maxUseRatioPercent: "주문당 최대 사용 비율",
  rewardBalanceWarnPercent: "발행 잔액 / 월 거래액 경고",
  manualGrantMax: "수동 지급 1회 상한",
  adminSessionHours: "관리자 세션",
  adminIdleMinutes: "미활동 자동 로그아웃",
  impersonationMinutes: "대신 보기 기본 세션",
  ...BOOL_LABEL,
};

function show(it: Item, v: Value): string {
  if (it.key === "carryOverAlways") return v ? "항상 이월" : "파트너스 선택";
  if (it.kind === "bool") return v ? "켜짐" : "꺼짐";
  if (it.kind === "enum") return ENUM_LABEL[it.key]?.(Number(v)) ?? `${v}${UNIT[it.unit] ?? ""}`;
  return `${Number(v).toLocaleString("ko-KR")}${UNIT[it.unit] ?? ""}`;
}
function invalid(it: Item, v: Value): string | null {
  if (it.kind !== "int") return null;
  if (typeof v !== "number" || !Number.isInteger(v)) return "숫자를 입력해 주십시오";
  if (it.key === "priceNoticeDays" && v < 30) return "요금 변경 사전 고지는 30일 미만으로 줄일 수 없습니다";
  if ((it.min !== undefined && v < it.min) || (it.max !== undefined && v > it.max)) return `${it.min?.toLocaleString("ko-KR")}~${it.max?.toLocaleString("ko-KR")} 사이로 입력해 주십시오`;
  return null;
}

const Soon = () => <span className="c-alt">준비 중</span>;
const Pending = () => <span className="bdg b-gray" style={{ marginLeft: 8 }}>적용 예정</span>;

export default function PlatformPolicyPage() {
  const { me } = useAdmin();
  const canEdit = adminCan(me.role, "system.manage");
  const { confirm } = useConfirm();
  const [state, setState] = useState<Load>({ kind: "loading" });
  const [draft, setDraft] = useState<Record<string, Value>>({});
  const [toast, setToast] = useState<{ text: string; neg?: boolean } | null>(null);
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await adminApi<Policy>("/api/admin/settings/policy");
    if (id !== reqId.current) return;
    if (r.ok) {
      setDraft(Object.fromEntries(r.data.policy.map((p) => [p.key, p.value])));
      setState({ kind: "ok", data: r.data });
    } else setState({ kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  const data = state.kind === "ok" ? state.data : null;
  const by = new Map((data?.policy ?? []).map((p) => [p.key, p]));
  const changed = (data?.policy ?? []).filter((p) => draft[p.key] !== p.value);
  const errors = new Map(changed.map((p) => [p.key, invalid(p, draft[p.key])]).filter(([, e]) => e) as [string, string][]);
  const set = (key: string, v: Value) => setDraft((d) => ({ ...d, [key]: v }));

  const save = async () => {
    if (!data || changed.length === 0 || errors.size > 0) return;
    const values = Object.fromEntries(changed.map((p) => [p.key, draft[p.key]]));
    const ok = await confirm({
      title: `정책 ${changed.length}개를 변경하시겠습니까?`,
      body: changed.map((p) => `${NAME[p.key] ?? p.key} ${show(p, p.value)} → ${show(p, draft[p.key])}`).join(" · "),
      confirmLabel: "저장",
      run: async () => {
        const r = await adminApi<{ policy: Item[] }>("/api/admin/settings/policy", { method: "PATCH", json: { values } });
        if (!r.ok) return failMessage(r, "정책을 저장하지 못했습니다. 입력한 값을 확인해 주십시오.");
        setState({ kind: "ok", data: { ...data, policy: r.data.policy } });
        setDraft(Object.fromEntries(r.data.policy.map((p) => [p.key, p.value])));
        return undefined;
      },
    });
    if (ok) setToast({ text: "정책을 저장했습니다 · 로그 추적에 남겼습니다" });
  };
  const cancel = () => data && setDraft(Object.fromEntries(data.policy.map((p) => [p.key, p.value])));

  // 한 키의 입력(정수는 숫자 칸 + 단위, 선택지는 라디오, 켜기·끄기는 체크)
  const control = (key: string) => {
    const it = by.get(key);
    if (!it) return <Soon />;
    const v = draft[key];
    const err = errors.get(key);
    const suffix = SUFFIX[key];
    let input: React.ReactNode;
    if (it.kind === "int") {
      input = (
        <>
          <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <input className={`inp${err ? " err" : ""}`} style={{ width: 120 }} type="number" inputMode="numeric" aria-label={NAME[key]} aria-invalid={!!err} value={typeof v === "number" ? v : ""} disabled={!canEdit} onChange={(e) => set(key, e.target.value === "" ? Number.NaN : Number(e.target.value))} />
          <span className="c-alt">{suffix?.unit ?? UNIT[it.unit]}</span>
          </span>
          {suffix?.hint && <span className="t-c1 c-alt" style={{ display: "block" }}>{suffix.hint}</span>}
        </>
      );
    } else if (it.kind === "enum") {
      const opts = ENUM_ORDER[key] ?? it.options ?? [];
      input = (
        <div className="col" style={{ gap: 6 }}>
          {opts.map((o) => (
            <label key={o} className="chk">
              <input className="rdo" type="radio" name={key} checked={v === o} disabled={!canEdit} onChange={() => set(key, o)} />
              {ENUM_LABEL[key]?.(o) ?? o}
              {o === it.default ? " (기본)" : ""}
            </label>
          ))}
        </div>
      );
    } else if (key === "carryOverAlways") {
      input = (
        <div className="col" style={{ gap: 6 }}>
          {[false, true].map((o) => (
            <label key={String(o)} className="chk">
              <input className="rdo" type="radio" name={key} checked={v === o} disabled={!canEdit} onChange={() => set(key, o)} />
              {o ? "항상 이월" : "파트너스 선택 (기본 이월)"}
            </label>
          ))}
        </div>
      );
    } else {
      input = (
        <label className="chk">
          <input className="chkbox" type="checkbox" checked={v === true} disabled={!canEdit} onChange={(e) => set(key, e.target.checked)} />
          {BOOL_LABEL[key]}
        </label>
      );
    }
    return (
      <>
        {input}
        {!it.applied && <Pending />}
        {err && (
          <span className="err" role="alert" style={{ display: "block" }}>
            {err}
          </span>
        )}
      </>
    );
  };
  const row = (label: string, ...keys: string[]) => (
    <FormRow key={label} label={label}>
      <div className="col" style={{ gap: 6 }}>
        {keys.map((k) => (
          <div key={k}>{control(k)}</div>
        ))}
      </div>
    </FormRow>
  );
  const soon = (label: string) => (
    <FormRow key={label} label={label}>
      <Soon />
    </FormRow>
  );

  return (
    <>
      <AdminTopbar crumb="설정 › 플랫폼 기본 정책" />
      <main className="main policy-page">
        <PageHead title="플랫폼 기본 정책" />
        {state.kind === "loading" && <LoadingRows rows={5} />}
        {state.kind === "error" && <ErrorState title="불러오지 못했습니다." onRetry={() => void load()} />}
        {data && (
          <>
            {!canEdit && (
              <div className="note inf" style={{ marginBottom: 16 }}>
                조회 전용 권한입니다 · 변경 버튼은 보이지 않습니다 · 필요한 권한: 시스템 설정
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))", gap: 24, alignItems: "start" }} data-testid="policy-sections">
              <div className="col" style={{ gap: 24 }}>
                <FormSection title="가입 · 심사">
                  {row("가입 심사 목표 시간", "reviewTargetHours")}
                  {row("보완 요청 무응답 자동 반려", "supplementAutoRejectDays")}
                  {row("자동으로 확인한 결과", "bizStatusAutoCheck", "duplicateSignupBlock")}
                </FormSection>
                <FormSection title="구독 · 청구">
                  <FormRow label="무료 체험 중">{data.plans.length === 0 ? "-" : data.plans.map((p) => `${p.name} ${p.trialDays > 0 ? `${p.trialDays}일` : "없음"}`).join(" · ")}</FormRow>
                  {row("결제 실패 재시도", "paymentRetryCount")}
                  {row("연체 → 잠금", "overdueLockDays")}
                  {row("잠금 → 해지", "lockToCloseDays")}
                  {row("해지 후 데이터 보관", "dataRetentionDays")}
                  {row("요금 변경 사전 고지", "priceNoticeDays")}
                </FormSection>
                <FormSection title="방송 · 주문대기 · 방송 화면">
                  {row("기본 오픈 타이머", "openTimerSeconds")}
                  {row("방송 화면 재연결 최대", "overlayReconnectMax")}
                  {row("HIT 연출 노출", "hitSeconds")}
                  {row("방송 종료 후 대기 주문 이월", "carryOverAlways")}
                  {soon("강제")}
                </FormSection>
              </div>
              <div className="col" style={{ gap: 24 }}>
                <FormSection title="적립금 상한 (파트너스 정책 한도)">
                  {row("최대 적립률", "maxEarnRatePercent")}
                  {row("주문당 최대 사용 비율", "maxUseRatioPercent")}
                  {row("발행 잔액 / 월 거래액 경고", "rewardBalanceWarnPercent")}
                  {row("수동 지급 1회 상한", "manualGrantMax")}
                  {soon("실제 지급")}
                </FormSection>
                <FormSection title="보안 · 세션">
                  {row("관리자 세션", "adminSessionHours")}
                  {row("미활동 자동 로그아웃", "adminIdleMinutes")}
                  {row("대신 보기 기본 세션", "impersonationMinutes")}
                </FormSection>
                <FormSection title="법적 문서">
                  {soon("이용약관")}
                  {soon("개인정보처리방침")}
                  {row("재동의", "reconsentOnNewLegalVersion")}
                </FormSection>
              </div>
            </div>
            <div className="row" style={{ gap: 8, justifyContent: "center", marginTop: 24 }}>
              {canEdit && (
                <>
                  <button className="btn btn-lg" type="button" onClick={() => void save()} disabled={changed.length === 0 || errors.size > 0}>
                    저장
                  </button>
                  <button className="btn btn-lg btn-out" type="button" onClick={cancel} disabled={changed.length === 0}>
                    취소
                  </button>
                </>
              )}
              <Link className="btn btn-lg btn-out" href="/admin/logs">
                변경 이력
              </Link>
            </div>
          </>
        )}
      </main>
      {toast && <Toast text={toast.text} neg={toast.neg} onDone={() => setToast(null)} />}
    </>
  );
}
