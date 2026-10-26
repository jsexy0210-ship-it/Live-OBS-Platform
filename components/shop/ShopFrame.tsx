import Link from "next/link";
import { cookies } from "next/headers";
import { COOKIE_NAMES } from "../../lib/server/auth/policy";
import { resolveBuyerSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { publicCategories } from "../../lib/server/shop-category/service";
import { footerNotice } from "../../lib/server/shop-legal/notice";
import { ConfirmProvider } from "../admin-ui/ConfirmDialog";
import { EventPopupForPage } from "./EventPopup";
import LiveBar, { LiveProvider } from "./LiveBar";
import ShopChrome from "./ShopChrome";
import ShopClosedGate from "./ShopClosedGate";
import { ShopSessionProvider } from "./ShopSession";
import { HOSTING_DESCRIPTION, noticeRows, type FootRow } from "./footNotice";
import "./ShopLegal.css";

type BusinessInfo = { companyName?: unknown; representativeName?: unknown; businessNumber?: unknown; mailOrderNumber?: unknown };

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
const bizNo = (v: unknown) => {
  const s = text(v);
  return s && /^\d{10}$/.test(s) ? `${s.slice(0, 3)}-${s.slice(3, 5)}-${s.slice(5)}` : s;
};

// 바닥글 사업자 정보: 입점 신청 때 받은 값(Seller.businessInfo). 값이 없는 항목은 줄을 뺀다.
// 주소·고객센터·이메일·사업자정보 확인·호스팅 제공·구매안전서비스·미성년자 구매 안내는 파트너스 법정 고지 설정(SA-062)에서 입력한 값(footNotice.ts, 입력한 것만 표시).
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
export default async function ShopFrame({ slug, shopName, operatingState = "OPEN", children }: { slug: string; shopName: string; operatingState?: "OPEN" | "PREPARING" | "PAUSED"; children: React.ReactNode }) {
  const seller = await prisma.seller.findUnique({ where: { slug: slug.slice(0, 60) }, select: { id: true, businessInfo: true, shopTopNotice: true, bankAccount: { select: { bankName: true, accountNumber: true, accountHolder: true } } } });
  const token = (await cookies()).get(COOKIE_NAMES.buyer)?.value;
  const session = seller ? await resolveBuyerSession(prisma, token, seller.id) : null;
  const categories = (await publicCategories(prisma, slug.slice(0, 60))) ?? [];
  // 입점 신청 때 받은 검증 값 + 파트너스가 입력한 법정 표시(주소·고객센터·구매안전서비스 등, SA-062)
  const notice = seller ? await footerNotice(prisma, seller.id) : null;
  const bizNumber = text((seller?.businessInfo as BusinessInfo | null)?.businessNumber);
  // 고객센터·이메일은 아래 「고객센터」 칸에 따로 보여 주므로 사업자 정보 줄에서는 뺀다(정본 SH-001-PC-IA `.ft .cs`)
  const rows: FootRow[] = [...footRows(seller?.businessInfo).map(([label, value]) => ({ label, value })), ...(notice ? noticeRows(bizNumber, notice) : [])].filter((r) => r.label !== "고객센터" && r.label !== "이메일");
  const bank = seller?.bankAccount ?? null;
  const base = `/shop/${encodeURIComponent(slug)}`;
  const hasCs = !!(notice?.csPhone || notice?.csHours || notice?.csEmail || bank || notice?.kakaoChannelUrl || notice?.youtubeChannelUrl);
  return (
    <ConfirmProvider defaultTone="shop">
    <div className="shop-page">
      {text(seller?.shopTopNotice) && (
        <div className="shop-top-notice" aria-label="상단 공지">
          <div className="shop-wrap">{text(seller?.shopTopNotice)}</div>
        </div>
      )}
      <LiveProvider slug={slug}>
        <LiveBar />
        <ShopChrome slug={slug} shopName={shopName} loggedIn={!!session} nickname={session?.member.broadcastNickname ?? null} categories={categories} signupOpen={operatingState === "OPEN"} />
      </LiveProvider>
      <EventPopupForPage />
      <main className="shop-main">
        <ShopSessionProvider loggedIn={!!session}>
          <ShopClosedGate slug={slug} shopName={shopName} state={operatingState}>
            {children}
          </ShopClosedGate>
        </ShopSessionProvider>
      </main>
      <footer className="shop-foot">
        <div className="shop-wrap">
          <p className="shop-foot-name">{shopName}</p>
          <p className="shop-foot-links">
            <Link href={`${base}/terms`}>이용약관</Link>
            <Link href={`${base}/privacy`} className="shop-foot-strong">개인정보처리방침</Link>
            <Link href={`${base}/help`}>이용안내</Link>
            <Link href={`${base}/help`}>교환 · 환불 안내</Link>
            <Link href={`${base}/me/inquiries`}>문의하기</Link>
          </p>
          {hasCs && (
            <div className="shop-foot-cs" data-testid="shop-foot-cs">
              {(notice?.csPhone || notice?.csHours) && (
                <div>
                  <span>고객센터</span>
                  {notice?.csPhone && <span className="shop-foot-cs-v">{notice.csPhone}</span>}
                  {notice?.csHours && <span>{notice.csHours}</span>}
                </div>
              )}
              {bank && (
                <div>
                  <span>무통장 입금 계좌</span>
                  <span className="shop-foot-cs-v">{bank.bankName} {bank.accountNumber}</span>
                  <span>예금주 {bank.accountHolder}</span>
                </div>
              )}
              {notice?.csEmail && (
                <div>
                  <span>이메일</span>
                  <span className="shop-foot-cs-v">{notice.csEmail}</span>
                </div>
              )}
              {(notice?.kakaoChannelUrl || notice?.youtubeChannelUrl) && (
                <div className="shop-foot-sns">
                  {notice?.kakaoChannelUrl && (
                    <a className="shop-foot-kakao" href={notice.kakaoChannelUrl} target="_blank" rel="noopener noreferrer">
                      카카오톡 문의
                    </a>
                  )}
                  {notice?.youtubeChannelUrl && (
                    <a className="shop-foot-yt" href={notice.youtubeChannelUrl} target="_blank" rel="noopener noreferrer">
                      <i aria-hidden="true" />
                      유튜브 채널
                    </a>
                  )}
                </div>
              )}
            </div>
          )}
          {rows.length > 0 && (
            <dl className="shop-foot-info">
              {rows.map((r) => (
                <div key={r.label}>
                  <dt>{r.label}</dt>
                  <dd>{r.href ? <a href={r.href} target="_blank" rel="noreferrer noopener">{r.value}</a> : r.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {notice?.minorNotice && (
            <p className="shop-foot-minor" data-testid="shop-foot-minor">
              {notice.minorNotice}
            </p>
          )}
          <p className="shop-foot-by">
            {HOSTING_DESCRIPTION}
          </p>
        </div>
      </footer>
    </div>
    </ConfirmProvider>
  );
}
