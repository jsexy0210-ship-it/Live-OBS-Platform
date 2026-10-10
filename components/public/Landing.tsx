import Link from "next/link";
import Image from "next/image";
import symbol from "../../public/branding/streamshop-symbol.png";
import type { ReactNode } from "react";
import { pricingIntro } from "./pricingCopy";
import styles from "./Landing.module.css";

// PF-001: Streamlabs의 제품 소개 흐름을 스트림샵 판매자 경험에 맞춘 랜딩.
// 가격·체험 일수는 서버 데이터만 표시한다. 디자인 정본: design/project/PF-001.dc.tsx.
export type LandingPlan = { code: string; name: string; listPrice: number; salePrice: number; trialDays: number };
const won = (value: number) => `${value.toLocaleString("ko-KR")}원`;
const SIGNUP = "/seller/signup";

function Icon({ kind, className }: { kind: "arrow" | "play" | "shop" | "orders" | "screen" | "check" | "box"; className?: string }) {
  const paths = {
    arrow: <><path d="M4 12h15M13 5l7 7-7 7" /></>,
    play: <path d="m9 5 11 7-11 7z" />,
    shop: <><path d="M4 10v10h16V10M3 10l2-6h14l2 6M3 10c0 4 6 4 6 0 0 4 6 4 6 0 0 4 6 4 6 0M9 20v-6h6v6" /></>,
    orders: <><rect x="5" y="3" width="14" height="18" rx="3" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
    screen: <><rect x="2" y="4" width="20" height="13" rx="3" /><path d="M8 21h8M12 17v4m-2-13 4 3-4 3z" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    box: <><path d="m3 7 9-4 9 4v11l-9 4-9-4V7Zm0 0 9 4 9-4M12 11v11M7 5l10 4" /></>,
  };
  return <svg className={className} width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}

function Brand({ inverse = false }: { inverse?: boolean }) {
  return <span className={`${styles.brand} ${inverse ? styles.inverseBrand : ""}`} aria-label="스트림샵">
    {/* 승인된 심볼을 배경 제거한 로컬 자산. 새 심볼을 그리지 않는다. */}
    <Image src={symbol} alt="" width={36} height={40} sizes="36px" />
    <span>streamshop<span className={styles.brandDot}>.</span></span>
  </span>;
}
function Action({ href = SIGNUP, children, secondary = false }: { href?: string; children: ReactNode; secondary?: boolean }) {
  return <Link href={href} className={`${styles.button} ${secondary ? styles.secondary : ""}`}>{children}<Icon kind="arrow" /></Link>;
}
function Check({ children }: { children: ReactNode }) {
  return <li className={styles.check}><Icon kind="check" /><span>{children}</span></li>;
}

// 설명용 방송 화면: 실시간 고객 데이터와 구분되는 샘플이며 가짜 조작 버튼을 두지 않는다.
function BroadcastPreview() {
  return <figure className={styles.preview} aria-label="스트림샵 방송과 주문 관리 화면 예시">
    <div className={styles.previewTop}><span><i /><i /><i /></span><span>streamshop studio</span><span className={styles.connected}>연결됨</span></div>
    <div className={styles.studio}>
      <aside className={styles.studioNav}><span className={styles.studioActive}><Icon kind="screen" /><span>방송</span></span><span><Icon kind="orders" /><span>주문</span></span><span><Icon kind="shop" /><span>상품</span></span></aside>
      <div className={styles.broadcast}>
        <div className={styles.broadcastHeader}><span className={styles.liveBadge}>LIVE</span><span>오늘의 컬렉션을 만나는 시간</span><span className={styles.exampleLabel}>화면 예시</span></div>
        <div className={styles.stage}>
          <span className={styles.stageCaption}>YOUR NEXT<br /><strong>FAVORITE.</strong></span>
          <div className={styles.collectibles} aria-hidden="true"><div className={styles.cardBack}>S</div><div className={styles.cardFront}><span>THE COLLECTION</span><span className={styles.cardStar}>✳</span><span>OPEN SOMETHING NEW</span></div><div className={styles.productBox}><span>STREAM<br />COLLECTION</span><b>01</b></div></div>
          <div className={styles.currentOrder}><span className={styles.mintDot} /><div><small>지금 진행 중</small><strong>별빛수집가 님의 주문</strong></div><span>컬렉션 박스 × 1</span></div>
        </div>
      </div>
      <aside className={styles.orderPanel}>
        <div className={styles.orderPanelTitle}><strong>주문대기</strong><span>샘플 3건</span></div>
        {[["01", "별빛수집가", "컬렉션 박스 × 1", "진행 중"], ["02", "민트데이", "부스터 팩 × 2", "대기"], ["03", "오늘의취향", "스페셜 박스 × 1", "대기"]].map(([number, name, product, state], index) => <div className={`${styles.order} ${index === 0 ? styles.activeOrder : ""}`} key={number}><span>{number}</span><div><strong>{name}</strong><small>{product}</small></div><em>{state}</em></div>)}
        <div className={styles.orderNote}><Icon kind="check" /><span>주문부터 방송 화면까지<br />하나로 이어지는 판매 흐름</span></div>
      </aside>
    </div>
    <figcaption>방송 화면과 주문 관리 예시 · 상품과 주문 정보는 샘플이에요.</figcaption>
  </figure>;
}

const FEATURES = [
  { icon: "shop", number: "01", title: "내 브랜드의 쇼핑몰", text: "상품부터 재고, 주문과 배송까지. 판매에 필요한 일을 한곳에서 관리해요.", tag: "STORE" },
  { icon: "screen", number: "02", title: "방송에 맞춘 오버레이", text: "상품과 주문대기를 방송 화면에. 가로와 세로, 내 방송에 맞게 구성해요.", tag: "LIVE" },
  { icon: "orders", number: "03", title: "순서가 보이는 주문", text: "새 주문을 확인하고 진행 상태를 바꿔요. 시청자도 자신의 차례를 볼 수 있어요.", tag: "ORDERS" },
  { icon: "box", number: "04", title: "방송 이후의 운영까지", text: "방송이 끝난 뒤에도 주문을 이어서 관리해요. 배송과 고객 응대까지 한 흐름으로.", tag: "WORKFLOW" },
] as const;
const FAQ = [
  ["이미 쇼핑몰이 있어도 사용할 수 있나요?", "네. 오버레이 전용 플랜으로 기존 쇼핑몰의 주문을 방송 화면에 연결할 수 있어요. 연결 가능한 쇼핑몰과 지원 범위는 가입 과정에서 확인해 주세요."],
  ["OBS에 어떻게 연결하나요?", "스트림샵에서 방송 화면 주소를 복사한 뒤, OBS의 브라우저 소스에 넣으면 돼요. 브라우저 소스를 지원하는 다른 방송 프로그램에서도 사용할 수 있어요."],
  ["쇼핑몰이 없어도 시작할 수 있나요?", "쇼핑몰 통합 플랜에서 내 쇼핑몰을 열고 상품·주문·재고·배송을 함께 관리할 수 있어요. 가입 과정에서 운영 중인 쇼핑몰이 있는지 선택해 주세요."],
  ["트레이딩카드 외의 상품도 판매할 수 있나요?", "주문 순서에 맞춰 상품을 소개하고 판매하는 라이브 방송에도 사용할 수 있어요. 기능 안내에서 내 판매 방식에 맞는지 확인해 보세요."],
  ["구독료 외에 별도 비용이 있나요?", "결제대행 수수료, 문자·알림톡 등 사용량에 따른 비용과 선택한 부가 서비스 비용은 별도예요. 자세한 조건은 요금 안내에서 확인할 수 있어요."],
];
const PLAN_CONTENT: Record<string, { description: string; features: string[] }> = {
  OVERLAY_ONLY: { description: "지금 쓰는 쇼핑몰에 라이브 판매를 더해요.", features: ["외부 쇼핑몰 주문 연결", "실시간 주문 알림·표시", "OBS 방송 화면 구성", "방송 주문대기 관리"] },
  INTEGRATED: { description: "쇼핑몰부터 라이브 운영까지 함께 시작해요.", features: ["오버레이 전용의 모든 기능", "내 브랜드의 쇼핑몰", "상품·재고·주문 관리", "배송·회원 운영"] },
};

export function Landing({ plans, pricingStatus }: { plans: LandingPlan[]; pricingStatus: "available" | "unavailable" | "error" }) {
  const trial = plans.find((plan) => plan.trialDays > 0);
  const pricingMessage = pricingIntro(plans.map((plan) => plan.name), pricingStatus);
  return <div className={styles.page}>
    <a className={styles.skipLink} href="#main-content">본문 바로가기</a>
    <header className={styles.header}>
      <Link href="/about" className={styles.brandLink} aria-label="스트림샵 서비스 소개"><Brand /></Link>
      <nav className={styles.nav} aria-label="주요 메뉴"><a href="#features">주요 기능</a><a href="#how-it-works">시작하는 방법</a><a href="#pricing">요금 안내</a><a href="#faq">자주 묻는 질문</a></nav>
      <div className={styles.headerActions}><Link href="/seller/login" className={styles.login}>로그인</Link><Link href={SIGNUP} className={styles.headerCta}>시작하기 <span aria-hidden="true">↗</span></Link></div>
    </header>
    <main id="main-content" tabIndex={-1}>
      <section className={styles.hero}>
        <div className={styles.eyebrow}><span className={styles.mintDot} /> LIVE COMMERCE, CONNECTED</div>
        <h1>당신의 쇼핑몰이,<br /><span>라이브가 되는 순간.</span></h1>
        <p>쇼핑몰부터 방송 화면, 주문과 배송까지.<br />스트림샵으로 라이브 판매의 모든 순간을 연결해요.</p>
        <div className={styles.actions}><Action>스트림샵 시작하기</Action><Action href="#features" secondary>기능 둘러보기</Action></div>
        <p className={styles.heroNote}>{trial ? `${trial.name} ${trial.trialDays}일 체험 · 가입 후 안내에 따라 시작해요` : "기존 쇼핑몰 연결부터 새로운 쇼핑몰 개설까지"}</p>
        <BroadcastPreview />
      </section>
      <div className={styles.workflowStrip} aria-label="스트림샵으로 연결되는 판매 업무"><span>판매의 모든 순간을, 하나로.</span><div><span>SHOP</span><span aria-hidden="true">↗</span><span>LIVE</span><span aria-hidden="true">↗</span><span>ORDER</span><span aria-hidden="true">↗</span><span>DELIVERY</span></div></div>
      <section className={styles.section} id="features">
        <div className={styles.sectionHeading}><div><span className={styles.kicker}>BUILT FOR YOUR LIVE</span><h2>판매에 집중하세요.<br />연결은 스트림샵이 할게요.</h2></div><p>여러 화면을 오가던 번거로움은 줄이고,<br />내 상품과 고객에게 더 집중할 수 있도록.</p></div>
        <div className={styles.featureGrid}>{FEATURES.map((feature) => <article className={styles.featureCard} key={feature.tag}><div className={styles.featureTop}><Icon kind={feature.icon} /><span>{feature.number}</span></div><span className={styles.featureTag}>{feature.tag}</span><h3>{feature.title}</h3><p>{feature.text}</p></article>)}</div>
        <Link className={styles.textLink} href="/features">스트림샵 기능 자세히 보기 <Icon kind="arrow" /></Link>
      </section>
      <section className={styles.darkSection}>
        <div className={styles.split}>
          <div className={styles.splitCopy}><span className={styles.kicker}>YOUR LIVE, YOUR STYLE</span><h2>내 방송답게.<br />내 브랜드답게.</h2><p>시청자가 기억하는 건 내 브랜드니까.<br />상품, 주문대기, 안내 문구를 담은 방송 화면으로<br />나만의 라이브 판매를 완성해요.</p><ul><Check>OBS 브라우저 소스로 간편하게 연결</Check><Check>가로·세로 방송에 맞는 화면 구성</Check><Check>주문 순서와 진행 상태를 한눈에</Check></ul><Action href="/features">방송 화면 기능 살펴보기</Action></div>
          <div className={styles.overlayIllustration} role="img" aria-label="가로 방송과 세로 방송의 주문 표시 예시">
            <div className={styles.wideCanvas}><span className={styles.liveBadge}>LIVE</span><span className={styles.canvasTitle}>THE LIVE<br />COLLECTION</span><span className={styles.canvasOrder}><i /> 별빛수집가 님 · 지금 진행 중</span><span className={styles.canvasFormat}>16:9</span></div>
            <div className={styles.tallCanvas}><span className={styles.liveBadge}>LIVE</span><span className={styles.tallStar}>✳</span><span className={styles.tallOrder}>새로운 주문<br /><strong>민트데이 님</strong></span><span className={styles.canvasFormat}>9:16</span></div>
            <span className={styles.visualCaption}>방송 화면 구성 예시</span>
          </div>
        </div>
      </section>
      <section className={styles.section} id="how-it-works">
        <div className={styles.centerHeading}><span className={styles.kicker}>READY, SET, LIVE</span><h2>시작은 가볍게.<br />판매는 끊김 없이.</h2><p>지금 운영 중인 쇼핑몰이 있어도, 처음 시작해도 괜찮아요.</p></div>
        <ol className={styles.steps}>{[["내 판매 방식 선택", "기존 쇼핑몰을 연결하거나, 스트림샵에서 새 쇼핑몰을 시작해요."], ["방송 화면 준비", "상품과 주문이 보일 화면을 구성하고 OBS에 연결해요."], ["라이브 판매 시작", "테스트 주문으로 연결을 확인하고, 내 방송에서 판매를 시작해요."]].map(([title, text], index) => <li key={title}><span className={styles.stepNumber}>0{index + 1}</span><h3>{title}</h3><p>{text}</p></li>)}</ol>
      </section>
      <section className={styles.pricingSection} id="pricing">
        <div className={styles.centerHeading}><span className={styles.kicker}>A PLAN FOR YOUR NEXT STEP</span><h2>지금 필요한 만큼,<br />내 판매에 맞는 플랜.</h2><p data-testid="pricing-intro">{pricingMessage}</p></div>
        {plans.length > 0 ? <div className={styles.plans}>{plans.map((plan) => {
          const content = PLAN_CONTENT[plan.code];
          const integrated = plan.code === "INTEGRATED";
          return <article className={`${styles.planCard} ${integrated ? styles.integrated : ""}`} data-plan={plan.code} key={plan.code}>
            <span className={styles.planTag}>{integrated ? "쇼핑몰과 방송을 한곳에서" : plan.code === "OVERLAY_ONLY" ? "기존 쇼핑몰과 함께" : "내 판매에 맞게"}</span>
            <h3>{plan.name}</h3><p>{content?.description ?? "자세한 제공 기능은 요금 안내에서 확인해 주세요."}</p>
            <div className={styles.price}>{plan.listPrice > plan.salePrice && <del>정가 월 {won(plan.listPrice)}</del>}<div><strong>{won(plan.salePrice)}</strong><span>/ 월</span></div><small>{plan.listPrice > plan.salePrice ? "런칭 할인가 · " : ""}부가세 포함</small></div>
            <Action>{plan.trialDays > 0 ? `${plan.trialDays}일 체험 시작하기` : "파트너스 가입 신청"}</Action>
            {content && <ul>{content.features.map((feature) => <Check key={feature}>{feature}</Check>)}</ul>}
            <Link href="/pricing" className={styles.planDetail}>제공 기능과 이용 조건 보기 ↗</Link>
          </article>;
        })}</div> : <div className={styles.pricingEmpty}><Icon kind="orders" /><h3>{pricingStatus === "error" ? "요금 정보를 불러오지 못했어요" : "이용권을 준비하고 있어요"}</h3><p>{pricingStatus === "error" ? "잠시 후 다시 확인해 주세요. 기능 소개는 계속 둘러볼 수 있어요." : "가입 가능한 이용권이 준비되면 안내해 드릴게요."}</p><Action href="/pricing" secondary>요금 안내 보기</Action></div>}
        <p className={styles.feeNote}>결제대행 수수료 및 문자·알림톡 등 사용량에 따른 비용은 별도예요.<br /><Link href="/pricing">제공량과 부가 서비스 안내 확인하기</Link></p>
      </section>
      <section className={`${styles.section} ${styles.faqSection}`} id="faq"><div><span className={styles.kicker}>GOOD TO KNOW</span><h2>궁금한 점이<br />있으신가요?</h2><Link href="/faq" className={styles.textLink}>자주 묻는 질문 더 보기 <Icon kind="arrow" /></Link></div><div className={styles.faqList}>{FAQ.map(([question, answer]) => <details key={question}><summary>{question}<span aria-hidden="true">+</span></summary><p>{answer}</p></details>)}</div></section>
      <section className={styles.finalCta}><span className={styles.eyebrow}>YOUR SHOP. YOUR SHOW.</span><h2>다음 라이브는,<br />스트림샵과 함께.</h2><p>내 쇼핑몰과 방송이 만나는 새로운 판매의 시작.</p><Action>스트림샵 시작하기</Action></section>
    </main>
    <footer className={styles.footer}><div className={styles.footerTop}><div><Link href="/about" aria-label="스트림샵 서비스 소개"><Brand /></Link><p>쇼핑몰부터 라이브 판매까지, 한곳에서.</p></div><nav aria-label="하단 메뉴"><Link href="/features">기능 안내</Link><Link href="/pricing">요금 안내</Link><Link href="/faq">도움말</Link><Link href="/notices">공지사항</Link></nav></div><div className={styles.footerBottom}><span>StreamShop · LIVE COMMERCE, CONNECTED</span><div><Link href="/terms">이용약관</Link><Link href="/privacy">개인정보처리방침</Link></div></div></footer>
  </div>;
}
