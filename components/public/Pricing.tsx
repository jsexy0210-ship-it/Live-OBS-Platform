import Link from "next/link";
import { PublicFrame, type PublicCompanyInfo } from "./PublicFrame";
import type { LandingPlan } from "./Landing";
import { AUTOMATION_PRICE, FREE_RECONNECT_DAYS, REINSTALL_PRICE } from "../../lib/server/automation/config";

// PF-003 요금 안내(디자인 PF-003). 금액·체험 일수는 서버 요금제 값만 쓴다(하드코딩 금지).
// 플랜 안내 문구는 플랜 코드별로 둔다. 서버에 없는 플랜은 보여 주지 않는다.
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

const COPY: Record<string, string[]> = {
  OVERLAY_ONLY: ["OBS 방송 화면(세로 · 가로 템플릿)", "운영 중인 외부 쇼핑몰 웹훅 연결", "실시간 주문 알림 · 주문대기 표시", "직원 계정 · 권한"],
  INTEGRATED: ["오버레이 전용의 모든 기능", "스트림샵 스토어 · 상품 · 주문 운영", "결제 · 배송 · 송장 · 적립금", "영수증 · 세금계산서 발행"],
};
const START_LABEL: Record<string, string> = {
  OVERLAY_ONLY: "오버레이 전용으로 시작하기",
  INTEGRATED: "쇼핑몰 통합으로 시작하기",
};

// 정본 PF-003: 쇼핑몰 통합 카드에만 「추천」 배지·강조 테두리
const RECOMMENDED = "INTEGRATED";
const DISCOUNT_NOTICE = "지금은 런칭 할인가예요 할인이 끝나는 날짜는 정해지면 30일 전에 알려 드리고, 바뀌는 날짜와 금액은 결제 전 화면과 구독 관리 화면에서 다시 보여 드려요";

type BillingPolicy = { paymentRetryCount: number; overdueLockDays: number; lockToCloseDays: number };

const QA = (billingPolicy: BillingPolicy | null, trialPlan: LandingPlan | undefined, noTrialPlan: LandingPlan | undefined) => [
  ["언제 결제되나요?", trialPlan && noTrialPlan
    ? `${trialPlan.name}은 ${trialPlan.trialDays}일 체험이 끝난 다음 날, ${noTrialPlan.name}은 구독을 시작한 날 첫 결제가 되고 그 뒤로 매달 같은 날에 결제돼요 결제일은 구독 · 결제 메뉴에서 볼 수 있어요`
    : "체험이 있는 이용권은 체험이 끝난 다음 날, 없는 이용권은 구독을 시작한 날 첫 결제가 되고 그 뒤로 매달 같은 날에 결제돼요 결제일은 구독 · 결제 메뉴에서 볼 수 있어요"],
  ["결제가 실패하면 어떻게 되나요?", billingPolicy
    ? `하루 간격으로 ${billingPolicy.paymentRetryCount}번 다시 시도해요 처음 실패한 날부터 ${billingPolicy.overdueLockDays}일까지는 그대로 쓸 수 있고, 그 뒤에는 쇼핑몰과 방송 화면이 멈춰요 결제하면 바로 다시 열리고, 구독 기간은 원래 결제일부터 이어서 세요 잠긴 지 ${billingPolicy.lockToCloseDays}일이 지나면 체험 종료일이 등록된 계정은 자동으로 해지돼요`
    : "정기 결제 실패가 확인되면 정해진 유예 기간에는 계속 쓸 수 있어요 유예가 끝나면 결제할 때까지 쇼핑몰과 방송 화면이 멈춰요 결제하면 바로 다시 열려요"],
  ["해지하면 데이터는요?", "해지해도 남은 기간까지는 쓸 수 있어요 해지한 뒤 내 자료가 어떻게 되는지는 정해지는 대로 알려 드려요"],
  ["요금이 바뀌면요?", "새로 가입하는 분에게는 바뀐 요금이 바로 적용되고, 이미 구독 중이면 30일 전에 메일 · 알림톡 · 파트너스 관리자 공지로 알린 뒤 그다음 결제부터 적용돼요 런칭 할인이 끝나는 날짜도 정해지면 30일 전에 알려 드려요"],
];

export function Pricing({ plans, billingPolicy, companyInfo }: { plans: LandingPlan[]; billingPolicy: BillingPolicy | null; companyInfo?: PublicCompanyInfo | null }) {
  const shown = plans.filter((p) => COPY[p.code]);
  const trialPlan = shown.find((p) => p.trialDays > 0);
  const noTrialPlan = shown.find((p) => p.trialDays === 0);
  return (
    <PublicFrame active="/pricing" companyInfo={companyInfo}>
      <section className="pf-sec pf-pricing">
        <h1 className="t-d2">요금</h1>
        <p className="t-b1 c-neu">두 가지 이용권 · 판매 수수료는 없어요 · 모두 부가세 포함</p>
        {shown.length > 0 ? (
          <div className="pf-plans pf-plans-wide">
            {shown.map((p) => {
              const discounted = p.listPrice > p.salePrice;
              return (
                <div className={`card pf-plan${p.code === RECOMMENDED ? " pf-plan-rec" : ""}`} key={p.code} data-plan={p.code}>
                  {p.code === RECOMMENDED ? (
                    <div className="row between">
                      <span className="t-hl1">{p.name}</span>
                      <span className="bdg b-info">추천</span>
                    </div>
                  ) : (
                    <span className="t-hl1">{p.name}</span>
                  )}
                  {discounted && <span className="t-l2 c-alt num pf-strike">정가 월 {won(p.listPrice)}</span>}
                  <span className="t-d1 num pf-price">
                    {won(p.salePrice)}
                    <span className="t-l1 c-alt"> / 월 · 부가세 포함</span>
                  </span>
                  <span className="t-c1 pf-brand">
                    {discounted ? "런칭 할인가 · " : ""}
                    {p.trialDays > 0 ? `${p.trialDays}일 체험 뒤 첫 결제` : "체험 없이 바로 시작"}
                    {discounted ? ` · 할인이 끝나면 정가 월 ${won(p.listPrice)}` : ""}
                  </span>
                  <ul className="pf-check">
                    {COPY[p.code].map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                  <Link className="btn btn-xl btn-block" href="/seller/signup">
                    {START_LABEL[p.code]}
                  </Link>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="t-b2 c-alt" role="status">
            요금을 지금 불러오지 못했어요 잠시 뒤 다시 확인해 주세요
          </p>
        )}
        {shown.length > 0 && (
          <div className="pf-extra">
            {shown.some((p) => p.listPrice > p.salePrice) && (
              <div className="msg msg-info t-l2" style={{ display: "block" }}>
                {DISCOUNT_NOTICE}
              </div>
            )}
            <div className="card row pf-auto">
              <div className="col pf-auto-t">
                <span className="t-hl2">자동 연결 (선택)</span>
                <span className="t-l2 c-neu">외부 쇼핑몰 · 웹훅 · OBS 방송 화면 연결을 대신 해 드려요 · 직접 설정은 무료예요</span>
              </div>
              <div className="col pf-auto-p">
                <span className="t-h2 num">{won(AUTOMATION_PRICE)}</span>
                <span className="t-c1 c-alt">1회 · 부가세 포함 · 월 구독료와 별도</span>
              </div>
              <span className="t-c1 c-alt pf-auto-n">
                테스트 주문이 방송 화면에 표시되지 않으면 전액 환불 · 완료 뒤 {FREE_RECONNECT_DAYS}일 동안 같은 쇼핑몰 · 같은 PC는 무료로 재설치 · 그 밖의 재설치 {won(REINSTALL_PRICE)}
              </span>
            </div>
          </div>
        )}
        <div className="pf-faq pf-faq-wide pf-faq-c">
          <h2 className="t-t3">요금 · 결제 질문</h2>
          {QA(billingPolicy, trialPlan, noTrialPlan).map(([q, a]) => (
            <details key={q} open>
              <summary className="t-hl2">{q}</summary>
              <p className="t-b2 c-neu">{a}</p>
            </details>
          ))}
        </div>
      </section>
      <section className="pf-sec pf-end">
        <h2 className="t-t1">오늘 쇼핑몰을 열고, 다음 방송부터 줄을 세워요</h2>
        {trialPlan && noTrialPlan && (
          <p className="t-b1 c-neu">
            점검을 통과하면 바로 승인돼요 {trialPlan.name}은 승인되면 {trialPlan.trialDays}일 동안 체험할 수 있고, {noTrialPlan.name}은 체험 없이 구독으로 시작해요
          </p>
        )}
        <div className="pf-cta">
          <Link className="btn btn-lg" href="/seller/signup">
            파트너스 가입 신청
          </Link>
          <Link className="btn btn-lg btn-out" href="/pricing">
            요금 보기
          </Link>
        </div>
      </section>
    </PublicFrame>
  );
}
