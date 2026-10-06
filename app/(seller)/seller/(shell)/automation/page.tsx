"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { FormRow, FormSection, PageHead } from "../../../../../components/admin-ui";
import { Topbar, useSeller } from "../../../../../components/seller/SellerShell";
import { ErrorState, LoadingRows, NoPermission } from "../../../../../components/seller/States";
import { api, failMessage } from "../../../../../components/seller/api";
import { OPEN_STATUSES, stamp, type Job } from "../../../../../components/seller/automation/common";
import { AUTOMATION_PRICE, FREE_RECONNECT_DAYS, REINSTALL_PRICE } from "../../../../../lib/server/automation/config";

// SA-150 자동 연결 안내. API: GET /api/automation/jobs, POST /api/automation/check. 결제는 SA-151.
// 쇼핑몰 주소를 확인(지원 목록)해야 결제 화면으로 간다. 지원 밖 쇼핑몰은 결제 전에 막고 직접 설정(무료)으로 안내한다.
// 보드에 있고 서버에 없는 것: 「열리면 알림 받기」(알림 신청 API 없음)는 넣지 않았다.
type Check = { kind: "idle" } | { kind: "checking" } | { kind: "ok"; url: string } | { kind: "unsupported"; message: string } | { kind: "paused" } | { kind: "error"; message: string };
const FLOW = ["주소 확인", "결제", "자동 연결", "고객 확인", "작동 검증", "완료"];
const SUMMARY: [string, string][] = [
  ["다른 쇼핑몰에 우리 앱을 설치하고 주문 알림을 받도록 연결", ""],
  ["방송 프로그램(OBS)에 방송 화면 넣기", ""],
  ["주문이 나오는 방송 화면 기본 설정", ""],
  ["테스트 주문을 보내 실제로 화면에 나오는지 확인", ""],
];

export default function AutomationIntroPage() {
  const { me } = useSeller();
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
                <b>다른 쇼핑몰과 방송 프로그램(OBS)을 대신 이어 드립니다</b> · 선택 상품 · 1회 {AUTOMATION_PRICE.toLocaleString("ko-KR")}원 · 직접 설정은 무료입니다 · 끝나면 화면에 실제로 나오는지까지 확인해 드립니다
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
                    연결 가능한지 확인하기
                  </button>
                </div>
                <span className="t-c1 c-alt">입력한 주소의 쇼핑몰을 자동으로 이어 줄 수 있는지 확인합니다. 가능하면 결제로 넘어갑니다</span>
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
            <FormSection title="작업 범위">
              {SUMMARY.map(([t]) => (
                <FormRow key={t} label="">
                  {t}
                </FormRow>
              ))}
            </FormSection>
            <div className="card pad col" style={{ gap: 6 }}>
              <b>직접 하셔야 하는 일</b>
              <span className="t-l2 c-alt">쇼핑몰 관리자 로그인(아이디·비밀번호는 저장하지 않습니다) · 문자 인증 · 그림 속 글자 입력 · 방송용 컴퓨터에 연결 프로그램 설치(OBS 28 이상). 이 단계에서는 멈추고 알려 드리며, 마치면 자동으로 이어 갑니다. 전부 자동은 아닙니다.</span>
            </div>
            <div className="card pad col" style={{ gap: 6 }}>
              <b>환불 · 다시 설치</b>
              <span className="t-l2 c-alt">
                설정이 끝났는데 테스트 주문이 방송 화면에 나오지 않고, 도움을 받아도 해결되지 않으면 전액 환불합니다.
                <br />
                설정을 시작한 뒤에는 마음이 바뀌어도 환불되지 않습니다.
                <br />
                끝난 뒤 {FREE_RECONNECT_DAYS}일 안에 같은 쇼핑몰·같은 컴퓨터에 다시 설치하는 것은 무료입니다.
                <br />
                그 밖의 다시 설치는 {REINSTALL_PRICE.toLocaleString("ko-KR")}원(부가세 포함)입니다.
              </span>
            </div>
            <FormSection title="흐름">
              <nav className="rtabs" aria-label="자동 연결 흐름" data-testid="automation-flow">
                {FLOW.map((s, i) => (
                  <a key={s} className={i === 0 ? "on" : undefined} aria-current={i === 0 ? "step" : undefined}>
                    {i + 1} {s}
                  </a>
                ))}
              </nav>
            </FormSection>
            <FormSection title="결제 요약">
              <FormRow label="자동 연결">
                <b style={{ fontSize: 16 }}>{AUTOMATION_PRICE.toLocaleString("ko-KR")}원</b> <span className="t-c1 c-alt">1회 · 부가세 포함 · 월 구독료와 별도 · 자동 결제 없음</span>
              </FormRow>
              <FormRow label="대상">
                {me.shop.name} · {check.kind === "ok" ? check.url : url.trim() || "쇼핑몰 주소를 입력해 주십시오"}
              </FormRow>
              <FormRow label="소요 시간">보통 20~40분 · 고객 확인 대기 제외</FormRow>
              <FormRow label="실패하면">원인과 함께 다시 시도 · 지원으로도 안 되면 전액 환불</FormRow>
              <FormRow label="재설치">완료 뒤 {FREE_RECONNECT_DAYS}일 · 같은 쇼핑몰 · 같은 PC는 무료</FormRow>
            </FormSection>
            <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
              {check.kind === "ok" && !open ? (
                <Link className="btn btn-lg" href={`/seller/automation/pay?shop=${encodeURIComponent(check.url)}`} data-testid="automation-pay">
                  {AUTOMATION_PRICE.toLocaleString("ko-KR")}원 결제하고 자동 설정 시작하기
                </Link>
              ) : (
                <button className="btn btn-lg" type="button" disabled>
                  {AUTOMATION_PRICE.toLocaleString("ko-KR")}원 결제하고 자동 설정 시작하기
                </button>
              )}
              <Link className="btn btn-out btn-lg" href="/seller/onboarding">
                직접 설정하러 가기
              </Link>
              {check.kind !== "ok" && <span className="t-c1 c-alt" style={{ alignSelf: "center" }}>쇼핑몰 주소를 확인하면 결제할 수 있습니다</span>}
            </div>
          </div>
        )}
      </main>
    </>
  );
}
