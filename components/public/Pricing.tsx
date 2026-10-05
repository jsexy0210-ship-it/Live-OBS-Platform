import Link from "next/link";
import { PublicFrame } from "./PublicFrame";
import type { LandingPlan } from "./Landing";

// PF-003 요금 안내(디자인 PF-003). 금액·체험 일수는 서버 요금제 값만 쓴다(하드코딩 금지).
// 플랜 안내 문구는 플랜 코드별로 둔다. 서버에 없는 플랜은 보여 주지 않는다.
const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

const COPY: Record<string, string[]> = {
  OVERLAY_ONLY: ["OBS 오버레이(세로 · 가로 템플릿)", "운영 중인 외부 쇼핑몰 웹훅 연결", "실시간 주문 알림 · 주문대기 표시", "직원 계정 · 권한"],
  INTEGRATED: ["오버레이 전용의 모든 기능", "ONQ 스토어 · 상품 · 주문 운영", "결제 · 배송 · 송장 · 적립금", "영수증 · 세금계산서 발행"],
};

const QA = [
  ["언제 결제되나요?", "체험이 있는 플랜은 체험이 끝난 다음 날, 없는 플랜은 구독을 시작한 날 첫 결제가 되고 그 뒤로 매달 같은 날에 결제돼요. 결제일은 구독 · 결제 메뉴에서 볼 수 있어요."],
  ["해지하면 데이터는요?", "언제든 해지할 수 있고, 남은 기간까지 사용할 수 있어요."],
  ["요금이 바뀌면요?", "할인이 끝나는 날짜는 정해지면 30일 전에 알려 드리고, 바뀌는 날짜와 금액은 결제 전 화면과 구독 관리 화면에서 다시 보여 드려요."],
];

export function Pricing({ plans }: { plans: LandingPlan[] }) {
  const shown = plans.filter((p) => COPY[p.code]);
  return (
    <PublicFrame active="/pricing">
      <section className="pf-sec">
        <h1 className="t-d2">요금</h1>
        <p className="t-b1 c-neu">판매 수수료는 없어요 · 모두 부가세 포함</p>
        {shown.length > 0 ? (
          <div className="pf-plans pf-plans-wide">
            {shown.map((p) => {
              const discounted = p.listPrice > p.salePrice;
              return (
                <div className="card pf-plan" key={p.code} data-plan={p.code}>
                  <span className="t-hl1">{p.name}</span>
                  {discounted && <span className="t-l2 c-alt num pf-strike">정가 월 {won(p.listPrice)}</span>}
                  <span className="t-t1 num">
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
                  <Link className="btn btn-block" href="/seller/signup">
                    {p.name}로 시작하기
                  </Link>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="t-b2 c-alt" role="status">
            요금을 지금 불러오지 못했어요. 잠시 뒤 다시 확인해 주세요.
          </p>
        )}
        <div className="pf-faq pf-faq-wide">
          <h2 className="t-t3">요금 · 결제 질문</h2>
          {QA.map(([q, a]) => (
            <details key={q}>
              <summary className="t-hl2">{q}</summary>
              <p className="t-b2 c-neu">{a}</p>
            </details>
          ))}
        </div>
      </section>
      <section className="pf-sec pf-alt pf-end">
        <h2 className="t-t1">오늘 쇼핑몰을 열고, 다음 방송부터 줄을 세워요</h2>
        <div className="pf-cta">
          <Link className="btn" href="/seller/signup">
            파트너스 가입 신청
          </Link>
          <Link className="btn btn-out" href="/seller/login">
            로그인
          </Link>
        </div>
      </section>
    </PublicFrame>
  );
}
