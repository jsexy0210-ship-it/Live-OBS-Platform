import Link from "next/link";
import { PublicFrame } from "./PublicFrame";
import { LandingSample } from "./LandingSample";
import "../../styles/pf-sample.css";

// 요금 안내용 값(서버 요금제에서 읽은 것). 없으면 숫자 없이 안내 문구만 보여 준다.
export type LandingPlan = { code: string; name: string; listPrice: number; salePrice: number; trialDays: number };

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

const STEPS = [
  ["쇼핑몰을 열어요", "상품과 가격을 올리고 대표 색상과 로고를 정해요. 내 도메인도 연결할 수 있어요."],
  ["OBS에 방송 화면을 붙여요", "주소 하나를 브라우저 소스에 넣으면 끝. 세로 9:16과 가로 16:9 중 고르면 크기가 딱 맞아요."],
  ["방송 중 주문이 줄을 서요", "구매자가 주문하면 방송 화면에 닉네임과 상품이 바로 떠요. 순서대로 열어 주면 돼요."],
  ["HIT은 인기 카드에", "당첨 카드를 등록하면 6초 동안 크게 보여주고 인기 카드 1위에 올라가요."],
];

const FEATURES = [
  ["파트너스별 쇼핑몰", "내 로고와 색으로 꾸민 모바일 쇼핑몰. 상품 · 재고 · 주문 · 회원을 한곳에서 관리해요."],
  ["주문대기", "주문이 들어온 순서대로 줄을 세우고, 한 손으로 개봉 시작 · 완료 · 취소를 눌러요."],
  ["OBS 방송 화면", "현재 주문 카드 · 주문대기 · 인기 카드 · 공지 · 시계. 기본 템플릿 3종과 색만 고르면 돼요."],
  ["적립금 · 회원 등급", "등급별 적립률을 정하고 지급 · 회수 내역을 남겨요. 실제 지급은 스위치를 켤 때만."],
  ["구매자 알림", "주문 접수 · 개봉 완료 · 배송을 알림톡으로 알려요. 안 되면 문자로 보내요."],
  ["도우미", "사용법이 막히면 바로 물어봐요. 답할 수 없는 건 운영팀에 이어 드려요."],
];

const FAQ = [
  ["OBS 말고 다른 방송 프로그램도 되나요?", "브라우저 소스를 넣을 수 있는 프로그램이면 돼요. 세로 1080×1920, 가로 1920×1080 크기로 맞춰 두었어요."],
  ["결제는 어디로 들어오나요?", "결제 대금은 파트너스 이름으로 만든 결제 대행 계정으로 바로 들어와요. ONQ는 판매 수수료를 받지 않아요."],
  ["트레이딩카드가 아니어도 쓸 수 있나요?", "주문이 줄을 서는 방식의 라이브 판매라면 어떤 상품이든 쓸 수 있어요."],
];

// PF-001 서비스 소개(랜딩). 정본 PF-001 보드 구조. 요금·체험 일수는 서버 요금제 값을 읽어 표시한다(하드코딩 금지).
const CHECKS = ["파트너스 수수료 없음 · 결제는 ONQ 결제 연결로 한 번에", "언제든 해지 · 남은 기간까지 사용", "직원 계정과 권한 나누기", "세금계산서 발행"];

function Check({ children }: { children: React.ReactNode }) {
  return (
    <span className="row t-l1 pf-chk">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 12l5 5L20 7" />
      </svg>
      <span className="c-neu">{children}</span>
    </span>
  );
}

export function Landing({ plans }: { plans: LandingPlan[] }) {
  const cheapest = plans.length > 0 ? plans.reduce((a, b) => (b.salePrice < a.salePrice ? b : a)) : null;
  const trial = plans.find((p) => p.trialDays > 0);
  return (
    <PublicFrame>
      <section className="pf-hero">
        <div className="pf-hero-copy">
          <span className="bdg b-live">라이브 커머스 파트너스용</span>
          <h1 className="t-d1">
            주문이 들어오면,
            <br />
            방송 화면에 줄이 서요
          </h1>
          <p className="t-b1 c-neu pf-lead">파트너스별 쇼핑몰과 라이브 주문대기를 하나로. 파트너스는 팔고, 시청자는 자기 순서를 보고, 당첨 카드는 인기 카드에 남아요.</p>
          <div className="pf-cta">
            <Link className="btn btn-xl" href="/seller/signup">
              파트너스 가입 신청
            </Link>
            <Link className="btn btn-xl btn-out" href="/features">
              기능 둘러보기
            </Link>
          </div>
          {trial && <span className="t-c1 c-alt">{trial.name} {trial.trialDays}일 체험 · 카드 등록 없이 시작 · 점검 통과하면 바로 승인</span>}
        </div>
        <LandingSample />
      </section>

      <section className="pf-sec">
        <h2 className="t-t1">이렇게 써요</h2>
        <p className="t-b1 c-neu">설정 네 번이면 다음 방송부터 바로 써요.</p>
        <ol className="pf-steps">
          {STEPS.map(([t, d], i) => (
            <li key={t}>
              <span className="pf-num">{i + 1}</span>
              <span className="t-hl1">{t}</span>
              <p className="t-b2 c-neu">{d}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="pf-sec pf-alt">
        <h2 className="t-t1">기능</h2>
        <p className="t-b1 c-neu">쇼핑몰, 방송, 적립금까지 한 계정으로.</p>
        <div className="pf-grid">
          {FEATURES.map(([t, d]) => (
            <div className="card pf-card" key={t}>
              <div className="pf-ico" aria-hidden="true">
                ·
              </div>
              <div className="row" style={{ gap: 8 }}>
                <span className="t-hl1">{t}</span>
                {t === "도우미" && <span className="bdg b-info nodot">베타</span>}
              </div>
              <p className="t-b2 c-neu">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="pf-sec" id="pricing">
        <h2 className="t-t1">요금</h2>
        <p className="t-b1 c-neu">두 가지 이용권 · {plans.map((p) => p.name).join("과 ")} 중에 골라요.</p>
        {cheapest ? (
          <div className="pf-price-row">
            <div className="card col pf-price-card" data-plan={cheapest.code}>
              <div className="col" style={{ gap: 0 }}>
                {cheapest.listPrice > cheapest.salePrice && <span className="t-l2 c-alt num pf-strike">정가 월 {won(cheapest.listPrice)}부터</span>}
                <div className="row" style={{ gap: 6, alignItems: "baseline" }}>
                  <span className="t-d2 num pf-nowrap">{won(cheapest.salePrice)}</span>
                  <span className="t-l1 c-alt">/ 월부터 · {cheapest.listPrice > cheapest.salePrice ? "런칭 할인가 · " : ""}부가세 포함</span>
                </div>
              </div>
              <span className="t-l2 c-neu">
                {plans.map((p) => `${p.name} ${won(p.salePrice)}${p !== cheapest && p.listPrice > p.salePrice ? ` (정가 ${won(p.listPrice)})` : ""}`).join(" · ")} · 판매 수수료 없음
              </span>
              <span className="t-c1 c-alt">제공량(방송 시간 · 알림 건수 등)은 곧 알려 드릴게요.</span>
              <Link className="btn btn-lg" href="/seller/signup">
                {trial ? `${trial.trialDays}일 체험하기` : "파트너스 가입 신청"}
              </Link>
            </div>
            <div className="col pf-chks">
              {CHECKS.map((c) => (
                <Check key={c}>{c}</Check>
              ))}
            </div>
          </div>
        ) : (
          <>
            <p className="t-b2 c-alt">요금은 가입 신청 화면에서 알려 드려요.</p>
            <Link className="btn btn-lg pf-plan-cta" href="/seller/signup">
              파트너스 가입 신청
            </Link>
          </>
        )}
      </section>

      <section className="pf-sec pf-alt">
        <h2 className="t-t1">자주 묻는 질문</h2>
        <div className="pf-faq pf-faq-c pf-faq-home">
          {FAQ.map(([q, a], i) => (
            <details key={q} open={i === 0}>
              <summary className="t-hl2">{q}</summary>
              <p className="t-b2 c-neu">{a}</p>
            </details>
          ))}
        </div>
        <Link className="t-l1 pf-more" href="/faq">
          질문 더 보기 →
        </Link>
      </section>

      <section className="pf-sec pf-end">
        <h2 className="t-t1">오늘 쇼핑몰을 열고, 다음 방송부터 줄을 세워요</h2>
        {trial && (
          <p className="t-b1 c-neu">
            자동 점검을 통과하면 바로 승인돼요. {trial.name}은 승인되면 {trial.trialDays}일 동안 체험할 수 있어요.
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
