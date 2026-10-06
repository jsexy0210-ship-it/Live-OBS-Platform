import type { Prisma, PrismaClient, ShopEscrowKind, ShopLegalNotice } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";

// 쇼핑몰 바닥글 법정 표시 중 파트너스가 입력하는 값(SA-062 「사업자 정보·고지」). 규칙:
// - 상호·대표자·사업자등록번호·통신판매업 신고번호는 입점 신청 때 받은 검증 값(Seller.businessInfo)을 읽기 전용으로 보여 주고 여기서 바꾸지 않는다.
// - 주소·고객센터(전화·이메일·운영시간)·구매안전서비스 가입 정보·미성년자 구매 안내 글은 파트너스가 쓴 그대로 표시한다(법률 문구를 앱이 짓지 않음). 입력한 항목만 구매자에게 보인다.
// - 조회는 같은 쇼핑몰 파트너스 계정 누구나, 쓰기는 대표자·「쇼핑몰 설정」(SHOP_SETTINGS) 직원만. 쇼핑몰당 한 줄, 저장할 때마다 version이 올라간다(다른 창 덮어쓰기 막기).
// - 로그 추적에는 입력한 값을 남기지 않고 바뀐 칸 이름만 남긴다(개인 사업자 주소·연락처가 섞일 수 있음).

type Tx = Prisma.TransactionClient;
export type AuditMeta = { ip?: string | null; userAgent?: string | null };

export const ADDRESS_MAX = 200;
export const PHONE_MAX = 30;
export const EMAIL_MAX = 100;
export const HOURS_MAX = 100;
export const PROVIDER_MAX = 60;
export const URL_MAX = 300;
export const MINOR_NOTICE_MAX = 1000;

export type NoticeRejection =
  | "invalid_address"
  | "invalid_phone"
  | "invalid_email"
  | "invalid_hours"
  | "invalid_escrow_kind"
  | "invalid_escrow_provider"
  | "invalid_escrow_url"
  | "invalid_minor_notice"
  | "invalid_kakao_url"
  | "invalid_youtube_url"
  | "version_conflict";

// 파트너스 관리자 화면 문구(명사형·합니다체)
export const NOTICE_MESSAGES: Record<NoticeRejection, string> = {
  invalid_address: `주소를 ${ADDRESS_MAX}자 안에서 입력해 주십시오`,
  invalid_phone: "전화번호는 숫자·하이픈·괄호만 입력할 수 있습니다",
  invalid_email: "이메일 주소를 다시 확인해 주십시오",
  invalid_hours: `운영시간을 ${HOURS_MAX}자 안에서 입력해 주십시오`,
  invalid_escrow_kind: "구매안전서비스 종류를 다시 선택해 주십시오",
  invalid_escrow_provider: `가입한 업체 이름을 ${PROVIDER_MAX}자 안에서 입력해 주십시오`,
  invalid_escrow_url: "확인 주소는 https로 시작하는 주소만 입력할 수 있습니다",
  invalid_minor_notice: `미성년자 구매 안내를 ${MINOR_NOTICE_MAX.toLocaleString("ko-KR")}자 안에서 입력해 주십시오`,
  invalid_kakao_url: "카카오톡 채널 주소는 https로 시작하는 주소만 입력할 수 있습니다",
  invalid_youtube_url: "유튜브 채널 주소는 https로 시작하는 주소만 입력할 수 있습니다",
  version_conflict: "다른 곳에서 먼저 고쳤습니다. 새로고침한 뒤 다시 시도해 주십시오",
};

export type EscrowParam = "none" | "escrow" | "insurance";
const KIND_TO_DB: Record<EscrowParam, ShopEscrowKind> = { none: "NONE", escrow: "ESCROW", insurance: "INSURANCE" };
const KIND_FROM_DB: Record<ShopEscrowKind, EscrowParam> = { NONE: "none", ESCROW: "escrow", INSURANCE: "insurance" };

// 공정거래위원회 사업자정보 확인 주소(사업자등록번호 10자리). 주소 형식이 바뀌면 이 한 곳만 고친다.
export const BIZ_INFO_URL = "https://www.ftc.go.kr/bizCommPop.do?wrkr_no=";
export const bizInfoUrl = (businessNumber: unknown): string | null => (typeof businessNumber === "string" && /^\d{10}$/.test(businessNumber) ? BIZ_INFO_URL + businessNumber : null);

const obj = (raw: unknown) => (raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});
const lockSeller = (tx: Tx, sellerId: string) => tx.$queryRaw`SELECT 1 FROM "Seller" WHERE "id" = ${sellerId}::uuid FOR UPDATE`;
const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");

// 비어 있으면 "", 틀리면 null
const line = (v: unknown, max: number): string | null => (isEmpty(v) ? "" : cleanText(v, max, "name"));
const PHONE = /^[0-9+\-() ]{5,30}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function httpsUrl(v: unknown): string | null {
  if (isEmpty(v)) return "";
  if (typeof v !== "string" || v.trim().length > URL_MAX) return null;
  try {
    const u = new URL(v.trim());
    return u.protocol === "https:" && !u.username && !u.password && u.hostname.includes(".") ? u.href : null;
  } catch {
    return null;
  }
}

type Input = Pick<ShopLegalNotice, "address" | "csPhone" | "csEmail" | "csHours" | "escrowKind" | "escrowProvider" | "escrowUrl" | "minorNotice" | "kakaoChannelUrl" | "youtubeChannelUrl">;

function parseInput(raw: unknown): { ok: true; v: Input } | { ok: false; reason: Exclude<NoticeRejection, "version_conflict"> } {
  const b = obj(raw);
  const address = line(b.address, ADDRESS_MAX);
  if (address === null) return { ok: false, reason: "invalid_address" };
  const csPhoneRaw = isEmpty(b.csPhone) ? "" : typeof b.csPhone === "string" ? b.csPhone.normalize("NFKC").trim() : null;
  if (csPhoneRaw === null || (csPhoneRaw !== "" && !PHONE.test(csPhoneRaw))) return { ok: false, reason: "invalid_phone" };
  const csEmailRaw = isEmpty(b.csEmail) ? "" : typeof b.csEmail === "string" ? b.csEmail.normalize("NFKC").trim() : null;
  if (csEmailRaw === null || (csEmailRaw !== "" && (csEmailRaw.length > EMAIL_MAX || !EMAIL.test(csEmailRaw)))) return { ok: false, reason: "invalid_email" };
  const csHours = line(b.csHours, HOURS_MAX);
  if (csHours === null) return { ok: false, reason: "invalid_hours" };
  const kind = b.escrowKind === undefined ? "none" : (b.escrowKind as EscrowParam);
  if (!(kind in KIND_TO_DB)) return { ok: false, reason: "invalid_escrow_kind" };
  const escrowProvider = line(b.escrowProvider, PROVIDER_MAX);
  if (escrowProvider === null || (kind !== "none" && !escrowProvider)) return { ok: false, reason: "invalid_escrow_provider" };
  const escrowUrl = httpsUrl(b.escrowUrl);
  if (escrowUrl === null) return { ok: false, reason: "invalid_escrow_url" };
  const minorNotice = isEmpty(b.minorNotice) ? "" : cleanText(b.minorNotice, MINOR_NOTICE_MAX, "multiline");
  if (minorNotice === null) return { ok: false, reason: "invalid_minor_notice" };
  const kakaoChannelUrl = httpsUrl(b.kakaoChannelUrl);
  if (kakaoChannelUrl === null) return { ok: false, reason: "invalid_kakao_url" };
  const youtubeChannelUrl = httpsUrl(b.youtubeChannelUrl);
  if (youtubeChannelUrl === null) return { ok: false, reason: "invalid_youtube_url" };
  return { ok: true, v: { address, csPhone: csPhoneRaw, csEmail: csEmailRaw, csHours, escrowKind: KIND_TO_DB[kind], escrowProvider, escrowUrl, minorNotice, kakaoChannelUrl, youtubeChannelUrl } };
}

const view = (r: ShopLegalNotice | null) => ({
  address: r?.address ?? "",
  csPhone: r?.csPhone ?? "",
  csEmail: r?.csEmail ?? "",
  csHours: r?.csHours ?? "",
  escrowKind: KIND_FROM_DB[r?.escrowKind ?? "NONE"],
  escrowProvider: r?.escrowProvider ?? "",
  escrowUrl: r?.escrowUrl ?? "",
  minorNotice: r?.minorNotice ?? "",
  kakaoChannelUrl: r?.kakaoChannelUrl ?? "",
  youtubeChannelUrl: r?.youtubeChannelUrl ?? "",
  version: r?.version ?? 0,
});

const FIELDS = ["address", "csPhone", "csEmail", "csHours", "escrowKind", "escrowProvider", "escrowUrl", "minorNotice", "kakaoChannelUrl", "youtubeChannelUrl"] as const;
const changedFields = (before: ShopLegalNotice | null, after: Input) => FIELDS.filter((f) => (before?.[f] ?? (f === "escrowKind" ? "NONE" : "")) !== after[f]);

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
// 입점 신청 때 받은 검증 값(읽기 전용 표시)
export function businessView(info: unknown) {
  const b = (info && typeof info === "object" ? info : {}) as Record<string, unknown>;
  return { companyName: text(b.companyName), representativeName: text(b.representativeName), businessNumber: text(b.businessNumber), mailOrderNumber: text(b.mailOrderNumber) };
}

// ───────── 파트너스 관리자 ─────────

export async function readSellerNotice(db: PrismaClient, ctx: TenantContext) {
  const [row, seller] = await Promise.all([
    db.shopLegalNotice.findUnique({ where: { sellerId: ctx.sellerId } }),
    db.seller.findUnique({ where: { id: ctx.sellerId }, select: { businessInfo: true } }),
  ]);
  return { notice: view(row), business: businessView(seller?.businessInfo) };
}

// 저장(처음이면 만든다). 본문: { address?, csPhone?, csEmail?, csHours?, escrowKind?(none|escrow|insurance), escrowProvider?, escrowUrl?(https), minorNotice?, expectedVersion }
export async function saveSellerNotice(db: PrismaClient, ctx: TenantContext, raw: unknown, meta: AuditMeta = {}) {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const p = parseInput(raw);
  if (!p.ok) return p;
  const expected = obj(raw).expectedVersion;
  return db.$transaction(async (tx) => {
    await lockSeller(tx, ctx.sellerId);
    const before = await tx.shopLegalNotice.findUnique({ where: { sellerId: ctx.sellerId } });
    const current = before?.version ?? 0;
    if (expected !== current) return { ok: false as const, reason: "version_conflict" as const, currentVersion: current };
    const data = { ...p.v, version: current + 1 };
    const row = before ? await tx.shopLegalNotice.update({ where: { id: before.id }, data }) : await tx.shopLegalNotice.create({ data: { sellerId: ctx.sellerId, ...data } });
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "shop.legal_notice.update",
      targetType: "ShopLegalNotice",
      targetId: row.id,
      before: { version: current },
      after: { version: row.version, changed: changedFields(before, p.v), escrowKind: row.escrowKind },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    const seller = await tx.seller.findUnique({ where: { id: ctx.sellerId }, select: { businessInfo: true } });
    return { ok: true as const, notice: view(row), business: businessView(seller?.businessInfo) };
  });
}

// ───────── 구매자 바닥글 ─────────

// 바닥글에 보이는 값(운영 중인지는 부르는 쪽이 판단). 입력한 적 없으면 모두 빈 값.
export async function footerNotice(db: PrismaClient, sellerId: string) {
  return view(await db.shopLegalNotice.findUnique({ where: { sellerId } }));
}
