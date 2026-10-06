import Link from "next/link";
import "../../styles/tokens.css";
import "../../styles/lop.css";
import "../../styles/public.css";
import { PublicMobileMenu } from "./PublicMobileMenu";
import styles from "./PublicFrame.module.css";

// 공개 화면(PF) 공통 머리·꼬리. 디자인 PF-001 기준.
// 플랫폼 사업자 정보는 아직 정해진 값이 없다. 값이 없는 동안은 하단 정보 줄을 숨기고, 값이 정해지면 COMPANY에 넣는다(이 한 곳만 고친다).
const COMPANY: { label: string; value: string | null }[] = [
  { label: "상호", value: null },
  { label: "대표", value: null },
  { label: "사업자등록번호", value: null },
  { label: "통신판매업 신고", value: null },
  { label: "주소", value: null },
  { label: "고객센터", value: null },
];
const COMPANY_ROWS = COMPANY.filter((c) => c.value);
const NAV = [
  { href: "/features", label: "기능" },
  { href: "/pricing", label: "요금" },
  { href: "/faq", label: "자주 묻는 질문" },
  { href: "/notices", label: "공지" },
];

export function PublicFrame({ children, active, mobileHeader }: { children: React.ReactNode; active?: string; mobileHeader?: "landing" }) {
  return (
    <div className="app pf" data-theme="light">
      <header className="pf-head">
        <div className="pf-head-l">
          <Link className="logo pf-logo" href="/about">
            <span className="logo-sym" />
            <span className="logo-word" />
          </Link>
          <nav className="pf-nav" aria-label="주요 메뉴">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} aria-current={n.href === active ? "page" : undefined}>
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="pf-head-r">
          <Link className="btn btn-sm btn-out" href="/seller/login">
            로그인
          </Link>
          <Link className={`btn btn-sm ${mobileHeader === "landing" ? styles.landingSignup : ""}`} href="/seller/signup">
            파트너스 가입 신청
          </Link>
          {mobileHeader === "landing" && <PublicMobileMenu links={NAV} active={active} />}
        </div>
      </header>
      <main>{children}</main>
      <footer className="pf-foot">
        <div className="pf-foot-top">
          <div className="pf-foot-brand">
            <span className="logo">
              <span className="logo-sym" />
              <span className="logo-word" />
            </span>
            <span className="t-c1 c-alt">파트너스별 쇼핑몰과 라이브 방송 주문대기를 하나로.</span>
          </div>
          <div className="pf-foot-links">
            <Link href="/terms">이용약관</Link>
            <Link href="/privacy">
              <strong>개인정보처리방침</strong>
            </Link>
            <Link href="/notices">공지</Link>
            <Link href="/faq">자주 묻는 질문</Link>
          </div>
        </div>
        {COMPANY_ROWS.length > 0 && (
          <span className="t-c1 c-alt">
            {COMPANY_ROWS.map((c) => `${c.label} ${c.value}`).join(" · ")} · © 2026 {COMPANY.find((c) => c.label === "상호")?.value}
          </span>
        )}
      </footer>
    </div>
  );
}
