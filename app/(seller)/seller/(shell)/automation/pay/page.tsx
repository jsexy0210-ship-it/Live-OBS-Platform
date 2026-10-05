"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { FormRow, FormSection, PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import { SmartBackButton } from "../../../../../../components/seller/SmartBackButton";
import { api, failMessage } from "../../../../../../components/seller/api";
import { AUTOMATION_CONSENT, AUTOMATION_PRICE, FREE_RECONNECT_DAYS, REINSTALL_PRICE } from "../../../../../../lib/server/automation/config";

// SA-151 자동 연결 결제. API: POST /api/automation/purchase (Idempotency-Key + consent). 결제는 구독에 등록한 카드로만 한다(다른 카드 결제 API는 아직 없다).
// 실행은 서버가 PG에서 결제를 확인한 뒤에만 시작한다. 결제 결과를 아직 모르면(202) 진행 화면에서 확인한다.
const CHECKS = [
  "로그인·문자 인증·앱 설치 허용·연결 프로그램 설치는 제가 직접 합니다. 그 단계에서 멈추면 알림을 받고 이어 갑니다.",
  "방송 화면에 실제로 나오는지 확인이 끝나야 완료입니다. 테스트 주문이 방송 화면에 나오지 않고 도움을 받아도 해결되지 않으면 전액 환불합니다.",
  "설정을 시작한 뒤에는 마음이 바뀌어도 환불되지 않습니다.",
  `끝난 뒤 ${FREE_RECONNECT_DAYS}일 안에 같은 쇼핑몰·같은 컴퓨터에 다시 설치하는 것은 무료입니다. 그 밖의 다시 설치는 ${REINSTALL_PRICE.toLocaleString("ko-KR")}원입니다.`,
  "1회 결제입니다. 월 구독료와 별도이고 자동으로 다시 결제되지 않습니다.",
];
const REASON: Record<string, string> = {
  shop_not_supported: "아직 자동 연결할 수 없는 쇼핑몰입니다. 직접 설정으로 연결해 주십시오 · 결제되지 않았습니다",
  card_required: "결제 카드가 없습니다. 「이용권 · 결제」에서 카드를 등록한 뒤 다시 와 주십시오",
  job_in_progress: "이미 진행 중인 자동 연결이 있어 다시 결제하지 않았습니다",
  payment_failed: "결제되지 않았습니다. 카드사에서 승인을 거절했을 수 있습니다 · 카드를 확인한 뒤 다시 시도해 주십시오",
  consent_outdated: "안내 내용이 바뀌었습니다. 새로 고친 뒤 다시 확인해 주십시오",
  service_paused: "이번 달 자동 연결 접수를 잠시 멈췄습니다. 결제되지 않았습니다 · 다음 달에 다시 신청해 주십시오",
};

function Pay() {
  const router = useRouter();
  const shop = useSearchParams().get("shop") ?? "";
  const [card, setCard] = useState<string | null | undefined>(undefined);
  const [checked, setChecked] = useState<boolean[]>(CHECKS.map(() => false));
  const { confirm } = useConfirm();
  const [problem, setProblem] = useState<{ text: string; jobId?: string } | null>(null);
  // 같은 결제를 다시 눌러도 한 번만 처리되게 화면 진입마다 키 하나를 쓴다
  const key = useRef<string>("");
  if (!key.current) key.current = `buy_${crypto.randomUUID().replace(/-/g, "")}`;

  useEffect(() => {
    void api<{ subscription: { cardLabel: string | null } | null }>("/api/seller/subscription").then((r) => setCard(r.ok ? (r.data.subscription?.cardLabel ?? null) : null));
  }, []);

  const all = checked.every(Boolean);
  const pay = async () => {
    setProblem(null);
    const price = AUTOMATION_PRICE.toLocaleString("ko-KR");
    await confirm({
      title: `${price}원을 결제하시겠습니까?`,
      body: `등록된 카드${card ? `(${card})` : ""}로 ${price}원(부가세 포함)이 바로 결제되고 자동 설정이 시작됩니다. 시작한 뒤에는 마음이 바뀌어도 환불되지 않습니다. 결제 금액을 다시 입력해 주십시오.`,
      confirmLabel: `${price}원 결제하기`,
      danger: true,
      retype: { expected: String(AUTOMATION_PRICE), label: "결제 금액" },
      run: async () => {
        const r = await fetch("/api/automation/purchase", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key.current },
          body: JSON.stringify({ shopUrl: shop, consent: { agreed: true, noticeVersion: AUTOMATION_CONSENT.version } }),
          cache: "no-store",
        })
          .then(async (res) => ({ status: res.status, body: (await res.json().catch(() => ({}))) as { jobId?: string; error?: string; message?: string } }))
          .catch(() => ({ status: 0, body: {} as { jobId?: string; error?: string; message?: string } }));
        if (r.status >= 200 && r.status < 300 && r.body.jobId) {
          router.push(`/seller/automation/${r.body.jobId}`);
          return;
        }
        const text = (r.body.error && REASON[r.body.error]) || r.body.message || failMessage(r, "admin");
        setProblem({ text, jobId: r.body.jobId });
        return text;
      },
    });
  };

  const vat = Math.round(AUTOMATION_PRICE / 11);
  return (
    <>
      <Topbar crumb="방송 › 연동 › 자동 연결 › 자동 연결 결제" />
      <main className="main">
        <PageHead title="자동 연결 결제" />
        <div className="col" style={{ gap: 16 }}>
          <div className="msg msg-info" role="note"><span>결제가 확인된 뒤에 작업을 시작합니다</span></div>
          <FormSection title="결제 수단">
            <FormRow label="카드" required>
              <span data-testid="pay-card">{card === undefined ? "확인 중" : card ? `결제 카드: 이용권에 등록한 카드 · ${card}` : "등록된 카드가 없습니다"}</span>
              <span className="t-c1 c-alt">이용권에 등록한 카드로 결제합니다</span>
            </FormRow>
          </FormSection>
          <section className="au-fs">
            <div className="au-fs-h"><h2 className="au-fs-t">확인해 주십시오 · 필수 {CHECKS.length}개</h2></div>
            <div className="card pad col" style={{ gap: 8 }}>
              {CHECKS.map((t, i) => (
                <label key={t} className="chk">
                  <input type="checkbox" checked={checked[i]} onChange={(e) => setChecked(checked.map((c, j) => (j === i ? e.target.checked : c)))} data-testid={`pay-check-${i}`} />
                  {t}
                </label>
              ))}
              <span className="t-c1 c-alt">다섯 가지를 확인하면 결제할 수 있습니다 · 동의한 시각이 기록됩니다</span>
            </div>
          </section>
          <FormSection title="결제 금액">
            <FormRow label="자동 연결">{(AUTOMATION_PRICE - vat).toLocaleString("ko-KR")}원</FormRow>
            <FormRow label="부가세">{vat.toLocaleString("ko-KR")}원</FormRow>
            <FormRow label="합계"><b>{AUTOMATION_PRICE.toLocaleString("ko-KR")}원</b></FormRow>
            <FormRow label="대상">{shop || "쇼핑몰 주소가 없습니다"}</FormRow>
          </FormSection>
          {problem && (
            <div className="msg msg-neg" role="alert" data-testid="pay-problem">
              <span>
                <b>{problem.text}</b>
                {problem.jobId && <> · <Link href={`/seller/automation/${problem.jobId}`}>진행 확인</Link></>}
              </span>
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-lg" type="button" disabled={!all || !card || !shop} onClick={() => void pay()} data-testid="pay-submit">
              {`${AUTOMATION_PRICE.toLocaleString("ko-KR")}원 결제하기`}
            </button>
            <SmartBackButton fallback="/seller/automation" className="btn btn-out btn-lg">이전 화면으로</SmartBackButton>
          </div>
        </div>
      </main>
    </>
  );
}

export default function AutomationPayPage() {
  return (
    <Suspense>
      <Pay />
    </Suspense>
  );
}
