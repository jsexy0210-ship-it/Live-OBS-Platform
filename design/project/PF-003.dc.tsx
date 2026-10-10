"use client";

import { useState } from "react";
import { StreamShopBrand } from "../../components/public/StreamShopBrand";
import "../../styles/public-brand.css";

type Plan = {
  name: string;
  listPrice: string;
  price: string;
  offer: string;
  features: string[];
  recommended?: boolean;
  startLabel: string;
};

const plans: Plan[] = [
  {
    name: "오버레이 전용",
    listPrice: "99,000원",
    price: "69,000원",
    offer: "런칭 할인가 · 7일 체험 뒤 첫 결제 · 할인이 끝나면 정가 월 99,000원",
    features: ["OBS 방송 화면(세로 · 가로 템플릿)", "운영 중인 외부 쇼핑몰 웹훅 연결", "실시간 주문 알림 · 주문대기 표시", "직원 계정 · 권한"],
    startLabel: "오버레이 전용으로 시작하기",
  },
  {
    name: "쇼핑몰 통합",
    listPrice: "249,000원",
    price: "179,000원",
    offer: "런칭 할인가 · 체험 없이 바로 시작 · 할인이 끝나면 정가 월 249,000원",
    features: ["오버레이 전용의 모든 기능", "스트림샵 스토어 · 상품 · 주문 운영", "결제 · 배송 · 송장 · 적립금", "영수증 · 세금계산서 발행"],
    recommended: true,
    startLabel: "쇼핑몰 통합으로 시작하기",
  },
];

const questions = [
  ["언제 결제되나요?", "오버레이 전용은 7일 체험이 끝난 다음 날, 쇼핑몰 통합은 구독을 시작한 날 첫 결제가 되고 그 뒤로 매달 같은 날에 결제돼요 결제일은 구독 · 결제 메뉴에서 볼 수 있어요"],
  ["결제가 실패하면 어떻게 되나요?", "결제가 실패하면 하루 간격으로 3번 다시 시도해요 처음 실패한 날부터 7일까지는 그대로 쓸 수 있고, 그 뒤에는 결제할 때까지 쇼핑몰과 방송 화면이 멈춰요 결제하면 바로 다시 열리고, 구독 기간은 원래 결제일부터 이어서 세요 잠긴 지 30일이 지나면 자동으로 해지돼요"],
  ["해지하면 데이터는요?", "해지해도 이번 결제 기간이 끝날 때까지는 그대로 쓸 수 있고, 다음 결제부터 청구하지 않아요 해지한 뒤 90일 동안 자료를 보관하고, 그 안에 다시 구독하면 그대로 되살려요 90일이 지나면 삭제돼요 주문 · 결제 기록은 법에서 정한 5년 동안 따로 보관해요 삭제 전에 메일로 미리 알려 드려요"],
  ["요금이 바뀌면요?", "새로 가입하는 분에게는 바뀐 요금이 바로 적용되고, 이미 구독 중이면 30일 전에 메일 · 알림톡 · 파트너스 관리자 공지로 알린 뒤 그다음 결제부터 적용돼요 런칭 할인이 끝나는 날짜도 정해지면 30일 전에 알려 드려요"],
] as const;

const designHref = (id: string) => id === "PF-003" ? "/" : `/design/project/${id}.dc.html`;

function CheckMark() {
  return (
    <span style={{ color: "var(--pos-text)", flex: "none", marginTop: 2 }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M5 12l5 5L20 7" />
      </svg>
    </span>
  );
}

function BrandLogo({ size = 20 }: { size?: number }) {
  return <StreamShopBrand className="logo" style={{ fontSize: size }} width={28} height={31} />;
}

function BrandMark() {
  return <StreamShopBrand className="logo" width={28} height={31} />;
}

function PlanCard({ plan }: { plan: Plan }) {
  return (
    <div className="card col" style={{ padding: 32, gap: 14, flex: 1, minWidth: 0, ...(plan.recommended ? { boxShadow: "inset 0 0 0 2px var(--brand)" } : {}) }}>
      <div className="row between">
        <span className="t-hl1">{plan.name}</span>
        {plan.recommended && <span className="bdg b-info">추천</span>}
      </div>
      <div className="col" style={{ gap: 0 }}>
        <span className="t-l2 c-alt num" style={{ textDecoration: "line-through" }}>정가 월 {plan.listPrice}</span>
        <div className="row" style={{ gap: 6, alignItems: "baseline" }}>
          <span className="t-d1 num" style={{ whiteSpace: "nowrap" }}>{plan.price}</span>
          <span className="t-l1 c-alt">/ 월 · 부가세 포함</span>
        </div>
        <span className="t-c1" style={{ color: "var(--brand)" }}>{plan.offer}</span>
      </div>
      {plan.features.map((feature) => (
        <span className="row t-l2" style={{ gap: 8, alignItems: "flex-start" }} key={feature}>
          <CheckMark /><span className="c-neu">{feature}</span>
        </span>
      ))}
      <a className="btn btn-xl btn-block" href={designHref("PF-007-1")}>{plan.startLabel}</a>
    </div>
  );
}

function PricingQuestions() {
  const [open, setOpen] = useState(() => questions.map(() => true));
  return (
    <div className="col" style={{ maxWidth: 860, margin: "56px auto 0" }}>
      <h2 className="t-t3" style={{ marginBottom: 8 }}>요금 · 결제 질문</h2>
      {questions.map(([question, answer], index) => (
        <div className="col" style={{ boxShadow: "inset 0 -1px 0 var(--wds-line-normal-alternative)" }} key={question}>
          <button
            className="row between"
            type="button"
            aria-expanded={open[index]}
            onClick={() => setOpen((current) => current.map((value, i) => i === index ? !value : value))}
            style={{ padding: "18px 0", border: 0, background: "transparent", width: "100%", textAlign: "left", font: "inherit", color: "inherit", cursor: "pointer" }}
          >
            <span className="t-hl2">{question}</span><span className="c-alt" aria-hidden="true">{open[index] ? "−" : "+"}</span>
          </button>
          {open[index] && <p className="t-b2 c-neu" style={{ lineHeight: 1.6, padding: "0 0 16px" }}>{answer}</p>}
        </div>
      ))}
    </div>
  );
}

export default function PF003Canonical() {
  return (
    <div className="app streamshop-public" data-theme="light" style={{ width: 1440, display: "flex", flexDirection: "column", background: "var(--surface)" }}>
      <header className="row between streamshop-header" style={{ boxShadow: "inset 0 -1px 0 var(--wds-line-normal-alternative)" }}>
        <div className="row" style={{ gap: 40 }}>
          <a className="logo" href={designHref("PF-001")} style={{ fontSize: 20 }}><BrandMark /></a>
          <nav className="row" style={{ gap: 28 }} aria-label="공개 메뉴">
            <a className="t-l1 fw5 c-neu" href={designHref("PF-002")} style={{ color: "inherit", textDecoration: "none" }}>기능</a>
            <a className="t-l1 fw7" href={designHref("PF-003")} style={{ color: "inherit", textDecoration: "none" }} aria-current="page">요금</a>
            <a className="t-l1 fw5 c-neu" href={designHref("PF-004")} style={{ color: "inherit", textDecoration: "none" }}>자주 묻는 질문</a>
            <a className="t-l1 fw5 c-neu" href={designHref("PF-005")} style={{ color: "inherit", textDecoration: "none" }}>공지</a>
          </nav>
        </div>
        <div className="row streamshop-actions">
          <a className="streamshop-login" href={designHref("AU-002")}>로그인</a>
          <a className="streamshop-signup" href={designHref("PF-007-1")}>파트너스 가입 신청</a>
        </div>
      </header>

      <section style={{ padding: "72px 64px 80px", background: "var(--surface)" }}>
        <div className="col" style={{ gap: 8, marginBottom: 36, alignItems: "center", textAlign: "center" }}>
          <h1 className="t-d2">요금</h1>
          <p className="t-b1 c-neu">두 가지 이용권 · 판매 수수료는 없어요 · 모두 부가세 포함</p>
        </div>
        <div className="row" style={{ gap: 24, justifyContent: "center", alignItems: "stretch", maxWidth: 980, margin: "0 auto" }}>
          {plans.map((plan) => <PlanCard plan={plan} key={plan.name} />)}
        </div>
        <div className="col" style={{ maxWidth: 980, margin: "20px auto 0", gap: 12 }}>
          <div className="msg msg-info t-l2" style={{ display: "block" }}>지금은 런칭 할인가예요 할인이 끝나는 날짜는 정해지면 30일 전에 알려 드리고, 바뀌는 날짜와 금액은 결제 전 화면과 구독 관리 화면에서 다시 보여 드려요.</div>
          <div className="card row" style={{ padding: "20px 24px", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <div className="col" style={{ gap: 2, flex: 1, minWidth: 260 }}>
              <span className="t-hl2">자동 연결 (선택)</span>
              <span className="t-l2 c-neu">외부 쇼핑몰 · 웹훅 · OBS 방송 화면 연결을 대신 해 드려요 · 직접 설정은 무료예요</span>
            </div>
            <div className="col" style={{ gap: 0, alignItems: "flex-end" }}>
              <span className="t-h2 num">110,000원</span>
              <span className="t-c1 c-alt">1회 · 부가세 포함 · 월 구독료와 별도</span>
            </div>
            <span className="t-c1 c-alt" style={{ width: "100%" }}>테스트 주문이 방송 화면에 표시되지 않으면 전액 환불 · 완료 뒤 30일 동안 같은 쇼핑몰 · 같은 PC는 무료로 재설치 · 그 밖의 재설치 33,000원</span>
          </div>
        </div>
        <PricingQuestions />
      </section>

      <section style={{ padding: "80px 64px", background: "var(--page)" }}>
        <div className="col" style={{ alignItems: "center", gap: 16, textAlign: "center" }}>
          <h2 className="t-t1">오늘 쇼핑몰을 열고, 다음 방송부터 줄을 세워요</h2>
          <p className="t-b1 c-neu">점검을 통과하면 바로 승인돼요 오버레이 전용은 승인되면 7일 동안 체험할 수 있고, 쇼핑몰 통합은 체험 없이 구독으로 시작해요.</p>
          <div className="row" style={{ gap: 8 }}>
            <a className="btn btn-lg" href={designHref("PF-007-1")}>파트너스 가입 신청</a>
            <a className="btn btn-lg btn-out" href={designHref("PF-003")}>요금 보기</a>
          </div>
        </div>
      </section>

      <footer className="streamshop-footer" style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        <div className="row between" style={{ alignItems: "flex-start" }}>
          <div className="col" style={{ gap: 8 }}>
            <BrandLogo size={18} />
            <span className="t-c1 c-alt">파트너스별 쇼핑몰과 라이브 방송 주문대기를 하나로</span>
          </div>
          <div className="row" style={{ gap: 24 }}>
            <a className="t-l2" href={designHref("PF-008")}>이용약관</a>
            <a className="t-l2 fw7" href={designHref("PF-009")}>개인정보처리방침</a>
            <a className="t-l2" href={designHref("PF-005")}>공지</a>
            <a className="t-l2" href={designHref("PF-004")}>자주 묻는 질문</a>
          </div>
        </div>
        <span className="t-c1 c-alt">상호 [플랫폼 상호] · 대표 [플랫폼 대표자] · 사업자등록번호 [플랫폼 사업자등록번호] · 통신판매업 신고 [플랫폼 통신판매업 신고번호] · 주소 [플랫폼 주소지] · 고객센터 [플랫폼 고객센터] · © 2026 [플랫폼 상호]</span>
      </footer>
    </div>
  );
}
