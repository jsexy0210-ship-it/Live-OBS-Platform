"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { FormRow, FormSection, PageHead } from "../../../../../../components/admin-ui";
import { ErrorState, LoadingRows } from "../../../../../../components/seller/States";
import { adminApi } from "../../../_components/api";
import { AdminTopbar } from "../../../_components/AdminShell";

// MA-081 플랫폼 기본 정책(GET /api/admin/settings/policy, 읽기 전용 모음 조회). 정본: design/project/MA-081.dc.html(FINAL v293).
// 정본의 구역·행 순서를 그대로 두고, 서버가 실제 값을 주는 행만 값을 보인다. 서버에 없는 값은 지어내지 않고 「준비 중」으로 둔다(CLAUDE.md).
// 정책 값을 바꾸고 저장하는 API는 아직 없어 정본의 [저장][취소]는 넣지 않았다(바꾸기는 각 설정 화면).
type Plan = { code: string; name: string; trialDays: number };
type Policy = { plans: Plan[] };
type Load = { kind: "loading" } | { kind: "error" } | { kind: "ok"; data: Policy };

const Soon = () => <span className="c-alt">준비 중</span>;
const SOON_ROWS = (labels: string[]) => labels.map((l) => <FormRow key={l} label={l}><Soon /></FormRow>);

export default function PlatformPolicyPage() {
  const [state, setState] = useState<Load>({ kind: "loading" });
  const reqId = useRef(0);
  const load = useCallback(async () => {
    const id = ++reqId.current;
    setState({ kind: "loading" });
    const r = await adminApi<Policy>("/api/admin/settings/policy");
    if (id !== reqId.current) return;
    setState(r.ok ? { kind: "ok", data: r.data } : { kind: "error" });
  }, []);
  useEffect(() => void load(), [load]);

  return (
    <>
      <AdminTopbar crumb="설정 › 플랫폼 기본 정책" />
      <main className="main">
        <PageHead title="플랫폼 기본 정책" actions={<Link className="btn btn-out" href="/admin/logs">변경 이력</Link>} />
        {state.kind === "loading" && <LoadingRows rows={5} />}
        {state.kind === "error" && <ErrorState title="불러오지 못했습니다." onRetry={() => void load()} />}
        {state.kind === "ok" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(420px, 1fr))", gap: 24, alignItems: "start" }} data-testid="policy-sections">
            <div className="col" style={{ gap: 24 }}>
              <FormSection title="가입 · 심사">{SOON_ROWS(["가입 심사 목표 시간", "보완 요청 무응답 자동 반려", "자동으로 확인한 결과"])}</FormSection>
              <FormSection title="구독 · 청구">
                <FormRow label="무료 체험 중">
                  {state.data.plans.length === 0
                    ? "-"
                    : state.data.plans.map((p) => `${p.name} ${p.trialDays > 0 ? `${p.trialDays}일` : "없음"}`).join(" · ")}
                </FormRow>
                {SOON_ROWS(["결제 실패 재시도", "연체 → 잠금", "잠금 → 해지", "해지 후 데이터 보관", "요금 변경 사전 고지"])}
              </FormSection>
              <FormSection title="방송 · 주문대기 · 방송 화면">{SOON_ROWS(["기본 오픈 타이머", "방송 화면 재연결 최대", "HIT 연출 노출", "방송 종료 후 대기 주문 이월", "강제"])}</FormSection>
            </div>
            <div className="col" style={{ gap: 24 }}>
              <FormSection title="적립금 상한 (파트너스 정책 한도)">{SOON_ROWS(["최대 적립률", "주문당 최대 사용 비율", "발행 잔액 / 월 거래액 경고", "수동 지급 1회 상한", "실제 지급"])}</FormSection>
              <FormSection title="보안 · 세션">{SOON_ROWS(["관리자 세션", "미활동 자동 로그아웃", "대신 보기 기본 세션"])}</FormSection>
              <FormSection title="법적 문서">{SOON_ROWS(["이용약관", "개인정보처리방침", "재동의"])}</FormSection>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
