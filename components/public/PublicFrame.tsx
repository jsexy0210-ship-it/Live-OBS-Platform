import Link from "next/link";
import "../../styles/tokens.css";
import "../../styles/lop.css";
import "../../styles/public.css";

// 공개 화면(PF) 공통 머리·꼬리. 디자인 PF-001 기준.
// 플랫폼 사업자 정보는 아직 정해진 값이 없어 시안의 자리표시를 그대로 둔다(값이 정해지면 이 한 곳만 고친다).
const NAV = [
  { href: "/features", label: "기능" },
  { href: "/pricing", label: "요금" },
  { href: "/faq", label: "자주 묻는 질문" },
  { href: "/notices", label: "공지" },
];

export function PublicFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="app pf" data-theme="light">
      <header className="pf-head">
        <div className="pf-head-l">
          <Link className="logo pf-logo" href="/">
            <span className="logo-sym" />
            <span className="logo-word" />
          </Link>
          <nav className="pf-nav" aria-label="주요 메뉴">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href}>
                {n.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="pf-head-r">
          <Link className="btn btn-sm btn-out" href="/seller/login">
            로그인
          </Link>
          <Link className="btn btn-sm" href="/seller/signup">
            파트너스 가입 신청
          </Link>
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
        <span className="t-c1 c-alt">
          상호 [플랫폼 상호] · 대표 [플랫폼 대표자] · 사업자등록번호 [플랫폼 사업자등록번호] · 통신판매업 신고 [플랫폼 통신판매업 신고번호] · 주소 [플랫폼 주소지] · 고객센터 [플랫폼 고객센터] · © 2026 [플랫폼 상호]
        </span>
      </footer>
    </div>
  );
}
