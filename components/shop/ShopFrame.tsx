import Link from "next/link";
import { cookies } from "next/headers";
import { COOKIE_NAMES } from "../../lib/server/auth/policy";
import { resolveBuyerSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { publicCategories } from "../../lib/server/shop-category/service";
import { EventPopupForPage } from "./EventPopup";
import LiveBar from "./LiveBar";
import ShopChrome from "./ShopChrome";
import "./ShopLegal.css";

type BusinessInfo = { companyName?: unknown; representativeName?: unknown; businessNumber?: unknown; mailOrderNumber?: unknown };

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const bizNo = (v: unknown) => {
  const s = text(v);
  return s && /^\d{10}$/.test(s) ? `${s.slice(0, 3)}-${s.slice(3, 5)}-${s.slice(5)}` : s;
};

// 바닥글 사업자 정보: 입점 신청 때 받은 값(Seller.businessInfo). 값이 없는 항목은 줄을 뺀다.
// 주소·고객센터 번호는 파트너스 법정 고지 설정(SA-062)이 생기면 그 값을 더한다.
function footRows(info: unknown): [string, string][] {
  const b = (info && typeof info === "object" ? info : {}) as BusinessInfo;
  const rows: [string, string | null][] = [
    ["상호", text(b.companyName)],
    ["대표자", text(b.representativeName)],
    ["사업자등록번호", bizNo(b.businessNumber)],
    ["통신판매업 신고", text(b.mailOrderNumber)],
  ];
  return rows.filter((r): r is [string, string] => r[1] !== null);
}

// 구매자 쇼핑몰 공통 틀(일반 쇼핑몰 기본 구성, docs/DESIGN_PROMPT.md 「구매자 쇼핑몰(SH)」): 머리·바닥글·휴대폰 아래 고정 바.
// [slug]/layout.tsx가 한 번만 그린다(화면마다 다시 그리지 않아 이동할 때 머리가 깜빡이지 않는다).
// 로그인 상태는 이 쇼핑몰의 구매자 세션으로 판단한다(다른 쇼핑몰 세션은 로그인 안 함으로 본다).
export default async function ShopFrame({ slug, shopName, children }: { slug: string; shopName: string; children: React.ReactNode }) {
  const seller = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true, businessInfo: true } });
  const token = (await cookies()).get(COOKIE_NAMES.buyer)?.value;
  const session = seller ? await resolveBuyerSession(prisma, token, seller.id) : null;
  const categories = (await publicCategories(prisma, slug.slice(0, 60))) ?? [];
  const rows = footRows(seller?.businessInfo);
  return (
    <div className="shop-page">
      <ShopChrome slug={slug} shopName={shopName} loggedIn={!!session} nickname={session?.member.broadcastNickname ?? null} categories={categories} />
      <LiveBar slug={slug} />
      <EventPopupForPage />
      <main className="shop-main">{children}</main>
      <footer className="shop-foot">
        <div className="shop-wrap">
          <p className="shop-foot-name">{shopName}</p>
          {rows.length > 0 && (
            <dl className="shop-foot-info">
              {rows.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          )}
          <p className="shop-foot-links">
            <Link href={`/shop/${encodeURIComponent(slug)}/terms`}>이용약관</Link>
            <Link href={`/shop/${encodeURIComponent(slug)}/privacy`}>개인정보처리방침</Link>
          </p>
          <p className="shop-foot-by">
            <span className="logo-word" />로 운영하는 쇼핑몰이에요
          </p>
        </div>
      </footer>
    </div>
  );
}
