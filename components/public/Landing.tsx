import Link from "next/link";
import { PublicFrame } from "./PublicFrame";

// 요금 안내용 값(서버 요금제에서 읽은 것). 없으면 숫자 없이 안내 문구만 보여 준다.
export type LandingPlan = { code: string; name: string; listPrice: number; salePrice: number; trialDays: number };

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;

const STEPS = [
  ["쇼핑몰을 열어요", "상품과 가격을 올리고 대표 색상과 로고를 정해요. 내 도메인도 연결할 수 있어요."],
  ["OBS에 오버레이를 붙여요", "주소 하나를 브라우저 소스에 넣으면 끝. 세로 9:16과 가로 16:9 중 고르면 크기가 딱 맞아요."],
  ["방송 중 주문이 줄을 서요", "구매자가 주문하면 방송 화면에 닉네임과 상품이 바로 떠요. 순서대로 열어 주면 돼요."],
  ["HIT은 명예의 전당에", "당첨 카드를 등록하면 6초 동안 크게 보여주고 명예의 전당 1위에 올라가요."],
];

const FEATURES = [
  ["파트너스별 쇼핑몰", "내 로고와 색으로 꾸민 모바일 쇼핑몰. 상품 · 재고 · 주문 · 회원을 한곳에서 관리해요."],
  ["주문대기", "주문이 들어온 순서대로 줄을 세우고, 한 손으로 개봉 시작 · 완료 · 취소를 눌러요."],
  ["OBS 오버레이", "현재 주문 카드 · 주문대기 · 명예의 전당 · 공지 · 시계. 기본 템플릿 3종과 색만 고르면 돼요."],
  ["적립금 · 회원 등급", "등급별 적립률을 정하고 지급 · 회수 내역을 남겨요. 실지급은 스위치를 켤 때만."],
  ["구매자 알림", "주문 접수 · 개봉 완료 · 배송을 알림톡으로 알려요. 안 되면 문자로 보내요."],
  ["도우미", "사용법이 막히면 바로 물어봐요. 답할 수 없는 건 운영팀에 이어 드려요."],
];

const FAQ = [
  ["OBS 말고 다른 방송 프로그램도 되나요?", "브라우저 소스를 넣을 수 있는 프로그램이면 돼요. 세로 1080×1920, 가로 1920×1080 크기로 맞춰 두었어요."],
  ["결제는 어디로 들어오나요?", "파트너스 명의 PG로 직접 들어와요. 플랫폼은 판매 수수료를 받지 않아요."],
  ["트레이딩카드가 아니어도 쓸 수 있나요?", "주문이 줄을 서는 방식의 라이브 판매라면 어떤 상품이든 쓸 수 있어요."],
];

// PF-001 서비스 소개(랜딩). 요금은 서버 요금제 값을 읽어 표시한다(하드코딩 금지).
export function Landing({ plans }: { plans: LandingPlan[] }) {
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
          <p className="t-b1 c-neu pf-lead">
            파트너스별 쇼핑몰과 라이브 주문대기를 하나로. 파트너스는 팔고, 시청자는 자기 순서를 보고, 당첨 카드는 명예의 전당에 남아요.
          </p>
          <div className="pf-cta">
            <Link className="btn btn-xl" href="/seller/signup">
              파트너스 가입 신청
            </Link>
            <Link className="btn btn-xl btn-out" href="/features">
              기능 둘러보기
            </Link>
          </div>
        </div>
        <div className="pf-demo" aria-hidden="true">
          <div className="pf-demo-cur">
            <span className="pf-demo-tag">VIP 회원이 주문했어요</span>
            <strong>별빛사냥꾼</strong>
            <span>스타라이트 부스터 박스 ×2</span>
          </div>
          <div className="pf-demo-q">
            <span className="pf-demo-h">주문대기 · 3건 기다려요</span>
            <span>카드왕 · 드래곤 소울 부스터 ×1</span>
            <span>민트컨디션 · 문라이트 컬렉션 박스 ×1</span>
          </div>
        </div>
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
              <span className="t-hl1">{t}</span>
              <p className="t-b2 c-neu">{d}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="pf-sec" id="pricing">
        <h2 className="t-t1">요금</h2>
        <p className="t-b1 c-neu">플랜을 골라 시작해요. 판매 수수료는 없어요.</p>
        {plans.length > 0 ? (
          <div className="pf-plans">
            {plans.map((p) => (
              <div className="card pf-plan" key={p.code} data-plan={p.code}>
                <span className="t-hl1">{p.name}</span>
                {p.listPrice > p.salePrice && <span className="t-l2 c-alt num pf-strike">정가 월 {won(p.listPrice)}</span>}
                <span className="t-t1 num">
                  {won(p.salePrice)}
                  <span className="t-l1 c-alt"> / 월 · 부가세 포함</span>
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="t-b2 c-alt">요금은 가입 신청 화면에서 알려 드려요.</p>
        )}
        <Link className="btn btn-lg pf-plan-cta" href="/seller/signup">
          파트너스 가입 신청
        </Link>
      </section>

      <section className="pf-sec pf-alt">
        <h2 className="t-t1">자주 묻는 질문</h2>
        <div className="pf-faq">
          {FAQ.map(([q, a]) => (
            <details key={q}>
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
        <div className="pf-cta">
          <Link className="btn btn-lg" href="/seller/signup">
            파트너스 가입 신청
          </Link>
          <Link className="btn btn-lg btn-out" href="/seller/login">
            로그인
          </Link>
        </div>
      </section>
    </PublicFrame>
  );
}
