"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FormRow, FormSection, PageHead } from "../../../../../components/admin-ui";
import { Topbar } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";
import { OPEN_STATUSES, stamp, type Job } from "../../../../../components/seller/automation/common";
import { AUTOMATION_PRICE, FREE_RECONNECT_DAYS, REINSTALL_PRICE } from "../../../../../lib/server/automation/config";

// SA-150 자동 연결 안내. API: GET /api/automation/jobs, POST /api/automation/check. 결제는 SA-151.
// 쇼핑몰 주소를 확인(지원 목록)해야 결제 화면으로 간다. 지원 밖 쇼핑몰은 결제 전에 막고 직접 설정(무료)으로 안내한다.
// 보드에 있고 서버에 없는 것: 「열리면 알림 받기」(알림 신청 API 없음)는 넣지 않았다.
type Check = { kind: "idle" } | { kind: "checking" } | { kind: "ok"; url: string } | { kind: "unsupported"; message: string } | { kind: "paused" } | { kind: "error"; message: string };
const SUMMARY: [string, string][] = [
  ["외부 쇼핑몰 앱 설치 · 웹훅 연결", ""],
  ["OBS 오버레이 설치 · 브라우저 소스 등록", ""],
  ["주문 표시 · 오버레이 디자인 기본 설정", ""],
  ["테스트 주문 이벤트로 실제 표시 검증", ""],
];

export default function AutomationIntroPage() {
  const [jobs, setJobs] = useState<{ kind: "loading" } | { kind: "error"; status: number } | { kind: "ok"; jobs: Job[] }>({ kind: "loading" });
  const [url, setUrl] = useState("");
  const [check, setCheck] = useState<Check>({ kind: "idle" });

  const load = useCallback(async () => {
    const r = await api<{ jobs: Job[] }>("/api/automation/jobs");
    setJobs(r.ok ? { kind: "ok", jobs: r.data.jobs } : { kind: "error", status: r.status });
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const verify = async () => {
    const shopUrl = url.trim();
    if (!shopUrl) return setCheck({ kind: "error", message: "쇼핑몰 주소를 입력해 주십시오" });
    setCheck({ kind: "checking" });
    const r = await api<{ supported: boolean; paused?: boolean; message?: string }>("/api/automation/check", { method: "POST", body: { shopUrl } });
    if (!r.ok) return setCheck({ kind: "error", message: failMessage(r, "admin") });
    if (!r.data.supported) return setCheck({ kind: "unsupported", message: r.data.message ?? "아직 자동 연결할 수 없는 쇼핑몰입니다" });
    setCheck(r.data.paused ? { kind: "paused" } : { kind: "ok", url: shopUrl });
  };

  const open = jobs.kind === "ok" ? jobs.jobs.find((j) => OPEN_STATUSES.includes(j.status)) : undefined;

  return (
    <>
      <Topbar crumb="방송 › 연동 › 자동 연결" />
      <main className="main">
        <PageHead title="자동 연결" />
        {jobs.kind === "loading" && (
          <div className="card">
            <LoadingRows rows={4} />
          </div>
        )}
        {jobs.kind === "error" && (
          <div className="card">{jobs.status === 403 ? <NoPermission need="대표자" /> : <ErrorState title="자동 연결 정보를 불러오지 못했습니다" onRetry={() => void load()} />}</div>
        )}
        {jobs.kind === "ok" && (
          <div className="col" style={{ gap: 16 }}>
            <div className="msg msg-info" role="note">
              <span>
                <b>외부 쇼핑몰과 OBS 오버레이, 대신 연결해 드립니다</b> · 선택 상품 · 1회 {AUTOMATION_PRICE.toLocaleString("ko-KR")}원 · 직접 설정은 무료입니다 · 끝나면 실제로 작동하는지까지 확인해 드립니다
              </span>
            </div>
            {open && (
              <div className="msg msg-cau" role="status" data-testid="automation-open">
                <span>
                  <b>진행 중인 자동 연결이 있습니다.</b> {stamp(open.createdAt)} 시작 ·{" "}
                  <Link href={`/seller/automation/${open.id}`}>진행 확인</Link>
                </span>
              </div>
            )}
            <FormSection title="작업 범위">
              {SUMMARY.map(([t]) => (
                <FormRow key={t} label="">
                  {t}
                </FormRow>
              ))}
            </FormSection>
            <div className="card pad col" style={{ gap: 6 }}>
              <b>직접 해 주셔야 하는 일</b>
              <span className="t-l2 c-alt">쇼핑몰 관리자 로그인(아이디 · 비밀번호는 저장하지 않습니다) · 2단계 인증 · 보안문자 · 방송용 PC에 OBS 연결 도구 설치(OBS 28 이상). 그 단계에서는 멈추고 알려 드리고, 끝나면 자동으로 이어 갑니다. 완전 무인은 아닙니다.</span>
            </div>
            <div className="card pad col" style={{ gap: 6 }}>
              <b>환불 · 재설치</b>
              <span className="t-l2 c-alt">
                테스트 주문이 오버레이에 표시되지 않고 지원으로도 해결되지 않으면 전액 환불해 드립니다. 연결을 시작한 뒤에는 단순 변심으로 환불할 수 없습니다. 완료 뒤 {FREE_RECONNECT_DAYS}일 동안 같은 쇼핑몰 · 같은 PC는 무료로 재설치해 드립니다. 그 밖의 재설치는{" "}
                {REINSTALL_PRICE.toLocaleString("ko-KR")}원(부가세 포함)입니다.
              </span>
            </div>
            <FormSection title="쇼핑몰 주소 확인">
              <FormRow label="쇼핑몰 주소" required>
                <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                  <input
                    className="inp"
                    style={{ minWidth: 320 }}
                    type="text"
                    inputMode="url"
                    placeholder="운영 중인 쇼핑몰 주소"
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setCheck({ kind: "idle" });
                    }}
                    aria-label="쇼핑몰 주소"
                    data-testid="automation-url"
                  />
                  <button className="btn" type="button" disabled={check.kind === "checking"} onClick={() => void verify()}>
                    확인하기
                  </button>
                </div>
                <span className="t-c1 c-alt">주소로 자동 연결할 수 있는 쇼핑몰인지 먼저 확인합니다 · 확인되면 결제할 수 있습니다</span>
              </FormRow>
            </FormSection>
            {check.kind === "checking" && <div className="msg msg-info" role="status"><span>자동 연결할 수 있는지 확인하고 있습니다</span></div>}
            {check.kind === "error" && <div className="msg msg-neg" role="alert"><span>{check.message}</span></div>}
            {check.kind === "paused" && (
              <div className="msg msg-cau" role="status" data-testid="automation-paused">
                <span><b>이번 달 자동 연결 접수를 잠시 멈췄습니다.</b> 다음 달에 다시 신청해 주십시오 · 직접 설정은 무료로 지금 할 수 있습니다</span>
              </div>
            )}
            {check.kind === "unsupported" && (
              <div className="msg msg-cau" role="status" data-testid="automation-unsupported">
                <span><b>{check.message}</b> · 직접 설정은 무료입니다</span>
              </div>
            )}
            {check.kind === "ok" && (
              <div className="msg msg-pos" role="status" data-testid="automation-ok">
                <span><b>자동 연결할 수 있는 쇼핑몰입니다.</b> 결제하면 바로 시작합니다</span>
              </div>
            )}
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {check.kind === "ok" && !open ? (
                <Link className="btn btn-lg" href={`/seller/automation/pay?shop=${encodeURIComponent(check.url)}`} data-testid="automation-pay">
                  {AUTOMATION_PRICE.toLocaleString("ko-KR")}원 결제하고 시작
                </Link>
              ) : (
                <button className="btn btn-lg" type="button" disabled>
                  {AUTOMATION_PRICE.toLocaleString("ko-KR")}원 결제하고 시작
                </button>
              )}
              <Link className="btn btn-out btn-lg" href="/seller">
                직접 설정하기 (무료)
              </Link>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
