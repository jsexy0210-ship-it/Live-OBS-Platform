import Link from "next/link";
import "../../styles/tokens.css";
import "../../styles/lop.css";
import "../../styles/public.css";
import "../../styles/public-brand.css";
import { PublicMobileMenu } from "./PublicMobileMenu";
import { StreamShopBrand } from "./StreamShopBrand";
import styles from "./PublicFrame.module.css";

// 공개 화면(PF) 공통 머리·꼬리. 디자인 PF-001 기준.
export type PublicCompanyInfo = Partial<Record<"name" | "representative" | "businessNumber" | "mailOrderNumber" | "address" | "phone", string | null>>;
const COMPANY_FIELDS = [
  ["상호", "name"],
  ["대표", "representative"],
  ["사업자등록번호", "businessNumber"],
  ["통신판매업 신고", "mailOrderNumber"],
  ["주소", "address"],
  ["고객센터", "phone"],
] as const;
const NAV = [
  { href: "/features", label: "기능" },
  { href: "/pricing", label: "요금" },
  { href: "/faq", label: "자주 묻는 질문" },
  { href: "/notices", label: "공지" },
];

export function PublicFrame({ children, active, mobileHeader, companyInfo }: { children: React.ReactNode; active?: string; mobileHeader?: "compact"; companyInfo?: PublicCompanyInfo | null }) {
  const companyParts = COMPANY_FIELDS.flatMap(([label, key]) => {
    const value = companyInfo?.[key]?.trim();
    return value ? [`${label} ${value}`] : [];
  });
  if (companyInfo?.name?.trim()) companyParts.push(`© 2026 ${companyInfo.name.trim()}`);
  return (
    <div className={`app pf ${styles.page}`} data-theme="light">
      <header className={`pf-head ${styles.header}`}>
        <div className="pf-head-l">
          <Link className="logo pf-logo" href="/about" aria-label="스트림샵 서비스 소개">
            <StreamShopBrand className={styles.brand} width={28} height={31} />
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
          <Link className={styles.login} href="/seller/login">
            로그인
          </Link>
          <Link className={`${styles.signup} ${mobileHeader === "compact" ? styles.compactSignup : ""}`} href="/seller/signup">
            파트너스 가입 신청
          </Link>
          {mobileHeader === "compact" && <PublicMobileMenu links={NAV} active={active} />}
        </div>
      </header>
      <main>{children}</main>
      <footer className={`pf-foot ${styles.footer}`}>
        <div className="pf-foot-top">
          <div className="pf-foot-brand">
            <span className="logo">
              <StreamShopBrand className={styles.brand} width={28} height={31} />
            </span>
            <span className="t-c1 c-alt">파트너스별 쇼핑몰과 라이브 방송 주문대기를 하나로</span>
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
        {companyParts.length > 0 && (
          <span className="t-c1 c-alt">
            {companyParts.join(" · ")}
          </span>
        )}
      </footer>
    </div>
  );
}
