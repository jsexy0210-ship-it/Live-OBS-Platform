"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { FormRow, FormSection, PageHead, useConfirm } from "../../../../../../components/admin-ui";
import { Topbar } from "../../../../../../components/seller/SellerShell";
import TestModeNotice from "../../../../../../components/seller/TestModeNotice";
import { SmartBackButton } from "../../../../../../components/seller/SmartBackButton";
import { api, failMessage } from "../../../../../../components/seller/api";
import { AUTOMATION_CONSENT, AUTOMATION_PRICE } from "../../../../../../lib/server/automation/config";

// SA-151 자동 연결 결제. 구독에 등록한 카드: POST /api/automation/purchase (Idempotency-Key + consent).
// 「다른 카드로 결제」(이번 한 번만·저장 안 함): POST /api/automation/purchase/one-time → 응답 window가 있으면 나이스페이 결제창(AUTHNICE.requestPay)을 연다.
// 결제창 결과는 서버가 returnUrl로 받아 승인한 뒤 이동시킨다: 결제됨·확인 중 → /seller/automation/{jobId}?payment=paid|pending, 실패 → 이 화면 ?payment=failed.
// window가 null이면 결제창을 다시 열지 않고 진행 화면으로 간다. 실행은 서버가 PG에서 결제를 확인한 뒤에만 시작한다. 결제 결과를 아직 모르면(202) 진행 화면에서 확인한다.
type Nice = { requestPay: (o: Record<string, unknown>) => void };
function loadSdk(): Promise<Nice> {
  const w = window as unknown as { AUTHNICE?: Nice };
  if (w.AUTHNICE) return Promise.resolve(w.AUTHNICE);
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://pay.nicepay.co.kr/v1/js/";
    s.onload = () => (w.AUTHNICE ? resolve(w.AUTHNICE) : reject(new Error("sdk")));
    s.onerror = () => reject(new Error("sdk"));
    document.head.appendChild(s);
  });
}
type PayWindow = { clientId: string; method: string; orderId: string; amount: number; goodsName: string };
const CHECKS = [
  "로그인·문자 인증·앱 설치 허용·연결 프로그램 설치는 제가 직접 합니다. 그 단계에서 멈추면 알림을 받고 이어 갑니다.",
  "방송 화면에 실제로 나오는지 확인이 끝나야 완료입니다. 테스트 주문이 방송 화면에 나오지 않고 도움을 받아도 해결되지 않으면 전액 환불합니다.",
  "설정을 시작한 뒤에는 마음이 바뀌어도 환불되지 않습니다.",
  "완료 뒤 다시 설치 조건(무료 기간 · 요금)은 가격 결정 뒤 안내합니다 · 보류",
  "1회 결제입니다. 월 구독료와 별도이고 자동으로 다시 결제되지 않습니다.",
];
const REASON: Record<string, string> = {
  shop_not_supported: "아직 자동 연결할 수 없는 쇼핑몰입니다. 직접 설정으로 연결해 주십시오 · 결제되지 않았습니다",
  card_required: "결제 카드가 없습니다. 「이용권 · 결제」에서 카드를 등록한 뒤 다시 와 주십시오",
  job_in_progress: "이미 결제된 자동 연결이 있습니다. 같은 쇼핑몰에 진행 중인 작업이 있어 다시 결제하지 않았습니다",
  payment_not_ready: "결제 준비 중입니다. 잠시 후 다시 시도해 주십시오",
  idempotency_key_reused: "같은 결제 요청이 이미 처리되었습니다. 진행 화면에서 확인해 주십시오",
  payment_failed: "결제되지 않았습니다. 카드사에서 승인을 거절했을 수 있습니다 · 카드를 확인한 뒤 다시 시도해 주십시오",
  consent_outdated: "안내 내용이 바뀌었습니다. 새로 고친 뒤 다시 확인해 주십시오",
  service_paused: "이번 달 자동 연결 접수를 잠시 멈췄습니다. 결제되지 않았습니다 · 다음 달에 다시 신청해 주십시오",
};

function Pay() {
  const router = useRouter();
  const search = useSearchParams();
  const shop = search.get("shop") ?? "";
  // 결제창에서 실패하고 돌아온 경우(서버가 ?payment=failed로 되돌림): 다른 카드로 다시 시도하게 안내한다
  const failedBack = search.get("payment") === "failed";
  const [other, setOther] = useState(failedBack);
  const [card, setCard] = useState<string | null | undefined>(undefined);
  const [checked, setChecked] = useState<boolean[]>(CHECKS.map(() => false));
  const { confirm } = useConfirm();
  const [problem, setProblem] = useState<{ text: string; jobId?: string } | null>(null);
  // 같은 결제를 다시 눌러도 한 번만 처리되게 화면 진입마다 키 하나를 쓴다
  const key = useRef<string>("");
  if (!key.current) key.current = `buy_${crypto.randomUUID().replace(/-/g, "")}`;

  useEffect(() => {
    void api<{ subscription: { cardLabel: string | null } | null }>("/api/seller/subscription").then((r) => {
      const label = r.ok ? (r.data.subscription?.cardLabel ?? null) : null;
      setCard(label);
      // 구독에 등록한 카드가 없으면 다른 카드로만 결제할 수 있다
      if (!label) setOther(true);
    });
  }, []);

  const all = checked.every(Boolean);
  const pay = async () => {
    setProblem(null);
    const price = AUTOMATION_PRICE.toLocaleString("ko-KR");
    await confirm({
      title: `${price}원을 결제하시겠습니까?`,
      body: other
        ? `결제창에서 다른 카드를 입력하면 ${price}원(부가세 포함)이 결제되고 자동 설정이 시작됩니다. 이번 한 번만 쓰고 카드는 저장하지 않습니다. 시작한 뒤에는 마음이 바뀌어도 환불되지 않습니다. 결제 금액을 다시 입력해 주십시오.`
        : `등록된 카드${card ? `(${card})` : ""}로 ${price}원(부가세 포함)이 바로 결제되고 자동 설정이 시작됩니다. 시작한 뒤에는 마음이 바뀌어도 환불되지 않습니다. 결제 금액을 다시 입력해 주십시오.`,
      confirmLabel: `${price}원 결제하기`,
      danger: true,
      retype: { expected: String(AUTOMATION_PRICE), label: "결제 금액" },
      run: async () => {
        const r = await fetch(other ? "/api/automation/purchase/one-time" : "/api/automation/purchase", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": key.current },
          body: JSON.stringify({ shopUrl: shop, consent: { agreed: true, noticeVersion: AUTOMATION_CONSENT.version } }),
          cache: "no-store",
        })
          .then(async (res) => ({ status: res.status, body: (await res.json().catch(() => ({}))) as { jobId?: string; error?: string; message?: string; window?: PayWindow | null; returnUrl?: string } }))
          .catch(() => ({ status: 0, body: {} as { jobId?: string; error?: string; message?: string; window?: PayWindow | null; returnUrl?: string } }));
        if (r.status >= 200 && r.status < 300 && r.body.jobId) {
          // 다른 카드: 서버가 준 결제창 값을 그대로 나이스페이 결제창에 넘긴다(금액은 서버 값). 값이 없으면 결제창을 다시 열지 않고 진행 화면에서 결과를 본다
          if (other && r.body.window && r.body.returnUrl) {
            try {
              const nice = await loadSdk();
              nice.requestPay({ ...r.body.window, returnUrl: r.body.returnUrl });
              return;
            } catch {
              const text = "결제창을 열지 못했습니다. 잠시 후 다시 시도해 주십시오";
              setProblem({ text });
              return text;
            }
          }
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
          <div className="msg msg-info" role="note"><span>결제가 서버에서 확인된 뒤에 작업이 시작됩니다</span></div>
          <TestModeNotice kind="payment" formal />
          {failedBack && (
            <div className="msg msg-neg" role="alert" data-testid="pay-failed">
              <span><b>결제되지 않았습니다. 카드사에서 승인을 거절했습니다</b> · 다른 카드로 다시 시도해 주십시오</span>
            </div>
          )}
          <FormSection title="결제 수단">
            <FormRow label="카드" required>
              <div className="col" style={{ gap: 4, alignItems: "flex-start" }} data-testid="pay-card">
                <label className="chk">
                  <input className="rdo" type="radio" name="pay" checked={!other} disabled={!card} onChange={() => setOther(false)} />
                  {card === undefined ? "확인 중" : card ? `구독에 쓰는 카드 · ${card}` : "등록된 카드가 없습니다"}
                </label>
                <label className="chk">
                  <input className="rdo" type="radio" name="pay" checked={other} disabled={card === undefined} onChange={() => setOther(true)} data-testid="pay-other" />
                  다른 카드로 결제
                </label>
                <span className="t-c1 c-alt">이번 한 번만 씁니다 · 저장하지 않습니다</span>
              </div>
            </FormRow>
          </FormSection>
          <section className="au-fs">
            <div className="au-fs-h"><span className="row" style={{ gap: 8, alignItems: "center" }}><h2 className="au-fs-t">확인해 주십시오</h2><span className="bdg b-fail nodot">필수 {CHECKS.length}개</span></span></div>
            <div className="card pad col" style={{ gap: 8 }}>
              {CHECKS.map((t, i) => (
                <label key={t} className="chk">
                  <input type="checkbox" checked={checked[i]} onChange={(e) => setChecked(checked.map((c, j) => (j === i ? e.target.checked : c)))} data-testid={`pay-check-${i}`} />
                  {t}
                </label>
              ))}
              <span className="t-c1 c-alt">다섯 가지를 확인하면 결제할 수 있습니다 · 동의한 시각과 문구 버전을 기록합니다</span>
            </div>
          </section>
          <section className="au-fs">
            <div className="au-fs-h"><h2 className="au-fs-t">결제 금액</h2></div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>항목</th>
                  <th style={{ width: 200 }}>금액</th>
                </tr>
              </thead>
              <tbody>
                <tr><td>자동 연결</td><td className="r">{(AUTOMATION_PRICE - vat).toLocaleString("ko-KR")}원</td></tr>
                <tr><td>부가세</td><td className="r">{vat.toLocaleString("ko-KR")}원</td></tr>
                <tr><td><b>합계</b></td><td className="r"><b>{AUTOMATION_PRICE.toLocaleString("ko-KR")}원</b></td></tr>
                <tr><td>대상</td><td className="r">{shop || "쇼핑몰 주소가 없습니다"}</td></tr>
              </tbody>
            </table>
          </section>
          {problem && (
            <div className="msg msg-neg" role="alert" data-testid="pay-problem">
              <span>
                <b>{problem.text}</b>
                {problem.jobId && <> · <Link href={`/seller/automation/${problem.jobId}`}>진행 확인</Link></>}
              </span>
            </div>
          )}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn-lg" type="button" disabled={!all || (!other && !card) || !shop} onClick={() => void pay()} data-testid="pay-submit">
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
