import type { Prisma, PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { openBillingKey, sealBillingKey } from "../billing/secret";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { cleanText } from "../text/clean";
import { normalizeBusinessNumber, normalizeMailOrderNumber, normalizeOpenedOn, type BusinessStatus, type BusinessStatusProvider } from "./businessCheck";

// 쇼핑몰 통합 전환용 사업자·정산 정보(SA-005). 오버레이 전용으로 가입해 사업자 정보가 없던 계정도 통합으로 바꾸기 전에 채운다.
// 권한: 구독 관리(SUBSCRIPTION_MANAGE, 플랜 변경과 같음). 계좌번호는 응답에 마스킹으로만 나가고 로그 추적에도 원문을 남기지 않는다.
export const COMPANY_NAME_MAX = 60;
export const REPRESENTATIVE_NAME_MAX = 30;
export const ADDRESS_MAX = 200;
export const BANK_NAME_MAX = 20;
export const HOLDER_MAX = 30;
// 사업자 조회 하루 횟수(쇼핑몰마다, KST 자정 초기화). 조회 비용은 마스터 관리자 부담이라 횟수를 제한한다(COST_POLICY).
export const BUSINESS_CHECK_DAILY_LIMIT = 10;
// 상위 변경 게이트가 인정하는 사업자 조회 유효 시간
export const BUSINESS_CHECK_VALID_MS = 24 * 60 * 60_000;

export const INTEGRATION_MESSAGES = {
  invalid_profile: "사업자·정산 정보를 다시 확인해 주십시오",
  invalid_business_number: "사업자등록번호가 올바르지 않습니다",
  invalid_account_number: "계좌번호는 숫자 8~20자리로 입력해 주십시오",
  holder_mismatch: "예금주는 상호 또는 대표자명과 같아야 합니다",
  opened_on_required: "개업일자를 입력해 주십시오",
  invalid_opened_on: "개업일자를 다시 확인해 주십시오",
  daily_limit_exceeded: "오늘 사업자 조회 횟수를 모두 사용했습니다. 내일 다시 시도해 주십시오",
  lookup_failed: "사업자 조회에 실패했습니다. 잠시 뒤 다시 시도해 주십시오",
  secret_missing: "정산 정보를 안전하게 저장할 수 없습니다. 운영 담당에게 문의해 주십시오",
} as const;
export type IntegrationFailure = keyof typeof INTEGRATION_MESSAGES;
export const INTEGRATION_STATUS: Record<IntegrationFailure, number> = {
  invalid_profile: 400,
  invalid_business_number: 400,
  invalid_account_number: 400,
  holder_mismatch: 400,
  opened_on_required: 400,
  invalid_opened_on: 400,
  daily_limit_exceeded: 429,
  lookup_failed: 502,
  secret_missing: 503,
};

type Db = PrismaClient | Prisma.TransactionClient;
type Meta = { ip?: string | null; userAgent?: string | null };
type Row = {
  companyName: string | null;
  representativeName: string | null;
  businessNumber: string | null;
  mailOrderNumber: string | null;
  businessAddress: string | null;
  bankName: string | null;
  accountCipher: string | null;
  accountLast4: string | null;
  accountHolder: string | null;
  checkBusinessNumber: string | null;
  checkRepresentativeName: string | null;
  checkStatus: string | null;
  checkValid: boolean | null;
  checkedAt: Date | null;
};

const SECRET_PURPOSE = "settlement_account";
// 판매자 id와 용도를 묶어 빌링키 암호문과 서로 바꿔 쓸 수 없게 한다
const aad = (sellerId: string) => `${sellerId}:${SECRET_PURPOSE}`;
export const sealSettlementAccount = (plain: string, sellerId: string) => sealBillingKey(plain, aad(sellerId));
export const openSettlementAccount = (sealed: string, sellerId: string) => openBillingKey(sealed, aad(sellerId));

// 응답에는 뒤 4자리만 보여 준다(길이도 드러내지 않는다)
const maskAccount = (last4: string) => `****${last4}`;

const isComplete = (r: Row | null): boolean =>
  !!r && !!r.companyName && !!r.representativeName && !!r.businessNumber && !!r.businessAddress && !!r.bankName && !!r.accountCipher && !!r.accountLast4 && !!r.accountHolder;

// 조회 결과가 지금 저장된 사업자번호·대표자명에 대한 것이고 24시간 안이며 진위·상태가 정상이면 「사업자 확인됨」
function checkOf(r: Row | null, now: Date): "ok" | "unchecked" | "not_active" {
  if (!r || !r.checkedAt || r.checkBusinessNumber !== r.businessNumber || r.checkRepresentativeName !== r.representativeName) return "unchecked";
  if (now.getTime() - r.checkedAt.getTime() > BUSINESS_CHECK_VALID_MS) return "unchecked";
  return r.checkValid === true && r.checkStatus === "ACTIVE" ? "ok" : "not_active";
}

// 상위 변경(오버레이 전용 → 통합) 게이트: null이면 통과. planChange가 부른다(쓰기 없음).
export async function integrationGate(db: Db, sellerId: string, now: Date): Promise<"profile_incomplete" | "business_unchecked" | "business_not_active" | null> {
  const row = await db.sellerIntegrationProfile.findUnique({ where: { sellerId } });
  if (!isComplete(row)) return "profile_incomplete";
  const c = checkOf(row, now);
  return c === "ok" ? null : c === "unchecked" ? "business_unchecked" : "business_not_active";
}

export async function readIntegrationProfile(db: PrismaClient, ctx: TenantContext, now = new Date()) {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  const [row, seller] = await Promise.all([
    db.sellerIntegrationProfile.findUnique({ where: { sellerId: ctx.sellerId } }),
    db.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { businessInfo: true } }),
  ]);
  // 통합으로 가입한 쇼핑몰은 신청 때 확인한 사업자 정보가 있다(저장한 적 없으면 그 값으로 미리 채워 보여 준다)
  const info = (seller.businessInfo ?? {}) as { businessNumber?: unknown; representativeName?: unknown; mailOrderNumber?: unknown };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  return {
    business: {
      companyName: row?.companyName ?? "",
      representativeName: row?.representativeName ?? str(info.representativeName),
      businessNumber: row?.businessNumber ?? str(info.businessNumber),
      mailOrderNumber: row?.mailOrderNumber ?? (str(info.mailOrderNumber) || null),
      businessAddress: row?.businessAddress ?? "",
    },
    settlement:
      row?.bankName && row.accountLast4 && row.accountHolder
        ? { bankName: row.bankName, accountNumberMasked: maskAccount(row.accountLast4), accountHolder: row.accountHolder }
        : null,
    complete: isComplete(row),
    // 사업자 조회 상태(저장된 사업자번호·대표자명 기준, 24시간): 화면이 「조회」 버튼 상태를 그리는 데 쓴다
    businessCheck: { status: checkOf(row, now), checkedAt: row?.checkedAt?.toISOString() ?? null },
  };
}

const empty = (v: unknown) => v === undefined || v === null || v === "";

// PUT 본문: { companyName, representativeName, businessNumber, mailOrderNumber?, businessAddress, bankName, accountNumber, accountHolder }
export async function saveIntegrationProfile(db: PrismaClient, ctx: TenantContext, raw: unknown, meta: Meta = {}) {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const companyName = cleanText(b.companyName, COMPANY_NAME_MAX);
  const representativeName = cleanText(b.representativeName, REPRESENTATIVE_NAME_MAX);
  const businessAddress = cleanText(b.businessAddress, ADDRESS_MAX);
  const bankName = cleanText(b.bankName, BANK_NAME_MAX);
  const accountHolder = cleanText(b.accountHolder, HOLDER_MAX);
  if (!companyName || !representativeName || !businessAddress || !bankName || !accountHolder) return { ok: false as const, reason: "invalid_profile" as const };
  const businessNumber = typeof b.businessNumber === "string" ? normalizeBusinessNumber(b.businessNumber) : null;
  if (!businessNumber) return { ok: false as const, reason: "invalid_business_number" as const };
  let mailOrderNumber: string | null = null;
  if (!empty(b.mailOrderNumber)) {
    mailOrderNumber = typeof b.mailOrderNumber === "string" ? normalizeMailOrderNumber(b.mailOrderNumber) : null;
    if (!mailOrderNumber) return { ok: false as const, reason: "invalid_profile" as const };
  }
  const digits = typeof b.accountNumber === "string" ? b.accountNumber.replace(/[\s-]/g, "") : "";
  if (!/^\d{8,20}$/.test(digits)) return { ok: false as const, reason: "invalid_account_number" as const };
  if (accountHolder !== companyName && accountHolder !== representativeName) return { ok: false as const, reason: "holder_mismatch" as const };
  let accountCipher: string;
  try {
    accountCipher = sealSettlementAccount(digits, ctx.sellerId);
  } catch {
    return { ok: false as const, reason: "secret_missing" as const };
  }
  const data = { companyName, representativeName, businessNumber, mailOrderNumber, businessAddress, bankName, accountCipher, accountLast4: digits.slice(-4), accountHolder };
  await db.$transaction(async (tx) => {
    const before = await tx.sellerIntegrationProfile.findUnique({ where: { sellerId: ctx.sellerId } });
    // 저장하는 사업자번호·대표자명이 조회한 것과 다르면 앞의 조회 결과는 다른 사업자에 대한 것이라 지운다(조회를 먼저 하고 저장해도 같으면 유지)
    const sameBusiness = before?.checkBusinessNumber === businessNumber && before?.checkRepresentativeName === representativeName;
    const clearCheck = sameBusiness ? {} : { checkBusinessNumber: null, checkRepresentativeName: null, checkStatus: null, checkValid: null, checkedAt: null };
    await tx.sellerIntegrationProfile.upsert({ where: { sellerId: ctx.sellerId }, create: { sellerId: ctx.sellerId, ...data }, update: { ...data, ...clearCheck } });
    const last4 = (n: string | null) => (n ? n.slice(-4) : null);
    await writeAudit(tx, {
      actorType: ctx.actorType,
      actorId: ctx.actorId,
      sellerId: ctx.sellerId,
      action: "seller.integration_profile.update",
      targetType: "SellerIntegrationProfile",
      targetId: ctx.sellerId,
      // 계좌번호·사업자번호 원문은 남기지 않는다(뒤 4자리·은행·예금주만)
      before: before ? { companyName: before.companyName, businessNumberLast4: last4(before.businessNumber), bankName: before.bankName, accountLast4: before.accountLast4, accountHolder: before.accountHolder } : null,
      after: { companyName, businessNumberLast4: last4(businessNumber), bankName, accountLast4: data.accountLast4, accountHolder },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
  });
  return { ok: true as const };
}

// 사업자 상태 조회(POST). 본문 { businessNumber, representativeName, openedOn? }. 국세청 진위확인은 개업일자가 필요하다:
// 본문에 없으면 신청 때 받은 사업자 정보의 개업일자를 쓰고, 그것도 없으면 400 opened_on_required(오버레이 전용으로 가입한 계정).
// 결과(상태·진위)는 조회한 사업자번호·대표자명에 묶어 저장하고, 상위 변경 게이트가 24시간 동안 인정한다. 쇼핑몰당 하루 10번.
export async function checkBusiness(db: PrismaClient, provider: BusinessStatusProvider, ctx: TenantContext, raw: unknown, meta: Meta = {}) {
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE");
  const b = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const businessNumber = typeof b.businessNumber === "string" ? normalizeBusinessNumber(b.businessNumber) : null;
  if (!businessNumber) return { ok: false as const, reason: "invalid_business_number" as const };
  const representativeName = cleanText(b.representativeName, REPRESENTATIVE_NAME_MAX);
  if (!representativeName) return { ok: false as const, reason: "invalid_profile" as const };
  let openedOn: string | null = null;
  if (!empty(b.openedOn)) {
    openedOn = typeof b.openedOn === "string" ? normalizeOpenedOn(b.openedOn) : null;
    if (!openedOn) return { ok: false as const, reason: "invalid_opened_on" as const };
  } else {
    const info = ((await db.seller.findUniqueOrThrow({ where: { id: ctx.sellerId }, select: { businessInfo: true } })).businessInfo ?? {}) as { businessNumber?: unknown; openedOn?: unknown };
    // 신청 때 받은 개업일자는 신청한 사업자번호의 것일 때만 쓴다
    if (typeof info.openedOn === "string" && info.businessNumber === businessNumber) openedOn = normalizeOpenedOn(info.openedOn);
    if (!openedOn) return { ok: false as const, reason: "opened_on_required" as const };
  }
  const [{ n }] = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM "AuditLog"
    WHERE "sellerId" = ${ctx.sellerId}::uuid AND "action" = 'seller.integration.business_check'
      AND "createdAt" >= (date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')`;
  if (Number(n) >= BUSINESS_CHECK_DAILY_LIMIT) return { ok: false as const, reason: "daily_limit_exceeded" as const };
  // 조회를 시도하면(실패 포함) 횟수에 센다(외부 호출 비용). 조회 전에 먼저 남긴다.
  await writeAudit(db, {
    actorType: ctx.actorType,
    actorId: ctx.actorId,
    sellerId: ctx.sellerId,
    action: "seller.integration.business_check",
    targetType: "Seller",
    targetId: ctx.sellerId,
    after: { businessNumberLast4: businessNumber.slice(-4) },
    ip: meta.ip,
    userAgent: meta.userAgent,
  });
  const r = await provider.verify({ businessNumber, representativeName, openedOn });
  if (!r.ok) return { ok: false as const, reason: "lookup_failed" as const };
  const status: BusinessStatus = r.status;
  await db.sellerIntegrationProfile.upsert({
    where: { sellerId: ctx.sellerId },
    create: { sellerId: ctx.sellerId, checkBusinessNumber: businessNumber, checkRepresentativeName: representativeName, checkStatus: status, checkValid: r.valid, checkedAt: new Date() },
    update: { checkBusinessNumber: businessNumber, checkRepresentativeName: representativeName, checkStatus: status, checkValid: r.valid, checkedAt: new Date() },
  });
  return { ok: true as const, status, valid: r.valid };
}
