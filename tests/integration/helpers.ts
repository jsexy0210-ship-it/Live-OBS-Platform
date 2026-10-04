import { PrismaClient, type IdentityVerificationPurpose, type SellerStaffPermission } from "@prisma/client";
import { SIGNUP_CONSENT_VERSIONS } from "../../lib/server/buyers/consent";
import { SELLER_SIGNUP_CONSENT_VERSIONS } from "../../lib/server/sellers/signupConsent";
import { assertTestDatabaseUrl } from "../../lib/server/testDbGuard";
import { FAKE_IDENTITY_OTP, type IdentityPerson, type IdentityProvider } from "../../lib/server/identity/provider";
import { confirmIdentityCode, sendFirstIdentityCode, startIdentityVerification } from "../../lib/server/identity/verification";

// 모듈을 불러오는 순간 테스트 DB인지 확인한다.
const url = assertTestDatabaseUrl(process.env.DATABASE_URL);

export const db = new PrismaClient({ datasources: { db: { url } } });

export async function resetDb(): Promise<void> {
  const rows = await db.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  if (rows.length === 0) return;
  const list = rows.map((r) => `"public"."${r.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  // 마이그레이션이 넣는 기준 데이터(플랜 행)는 다시 넣는다(운영 DB와 같은 출발점)
  await seedPlans();
}

// 마이그레이션이 넣는 플랜 행(resetDb가 지우므로 구독 시험은 이것으로 다시 넣는다). STANDARD는 ONQ 1-C 이전 전 플랜.
export async function seedPlans() {
  const rows = [
    { code: "STANDARD", name: "월 구독", listPrice: 300000, salePrice: 199000, trialDays: 14 },
    { code: "OVERLAY_ONLY", name: "오버레이 전용", listPrice: 99000, salePrice: 69000, trialDays: 7 },
    { code: "INTEGRATED", name: "쇼핑몰 통합", listPrice: 249000, salePrice: 179000, trialDays: 0 },
  ];
  for (const r of rows) await db.subscriptionPlan.upsert({ where: { code: r.code }, create: r, update: {} });
  return Object.fromEntries(await Promise.all(rows.map(async (r) => [r.code, await db.subscriptionPlan.findUniqueOrThrow({ where: { code: r.code } })]))) as Record<
    "STANDARD" | "OVERLAY_ONLY" | "INTEGRATED",
    Awaited<ReturnType<typeof db.subscriptionPlan.findUniqueOrThrow>>
  >;
}

let seq = 0;
const next = () => ++seq;

export async function createSeller() {
  const n = next();
  // 기본은 체험하기 중(구독 차단 없이 다른 기능을 시험). 구독 시험은 trialEndsAt을 직접 바꾼다.
  const seller = await db.seller.create({
    data: { slug: `shop-${n}`, shopName: `쇼핑몰 ${n}`, status: "ACTIVE", trialEndsAt: new Date("2999-12-31T00:00:00Z") },
  });
  const grade = await db.memberGrade.create({
    data: { sellerId: seller.id, displayName: "일반", sortOrder: 0, systemKey: "BASIC" },
  });
  return { seller, grade };
}

export async function createBuyer(
  sellerId: string,
  gradeId: string,
  phone = `010${String(next()).padStart(8, "0")}`,
  ciHash = `ci-${next()}`,
) {
  const n = next();
  return db.buyerMember.create({
    data: {
      sellerId,
      gradeId,
      loginId: `buyer${n}`,
      passwordHash: "x",
      name: `구매자${n}`,
      phone,
      broadcastNickname: `닉네임${n}`,
      ciHash,
      identityVerifiedAt: new Date(),
      birthDate: new Date("1990-01-01"),
    },
  });
}

export async function createPaidOrderItem(sellerId: string, buyerMemberId: string, stock = 10) {
  const product = await db.product.create({ data: { sellerId, name: "부스터 팩", price: 5000, status: "ON_SALE" } });
  const option = await db.productOption.create({ data: { sellerId, productId: product.id, name: "1팩", stock } });
  const order = await db.order.create({
    data: {
      sellerId,
      orderNo: next(),
      buyerMemberId,
      status: "PAID",
      broadcastNicknameSnapshot: "닉네임",
      totalAmount: 5000,
      paidAt: new Date(),
    },
  });
  const item = await db.orderItem.create({
    data: {
      sellerId,
      orderId: order.id,
      productId: product.id,
      optionId: option.id,
      productNameSnapshot: product.name,
      optionNameSnapshot: option.name,
      unitPrice: 5000,
      quantity: 1,
    },
  });
  return { product, option, order, item };
}

export const PASSWORD = "test-password-1";
let pwHash: Promise<string> | undefined;
async function passwordHash() {
  const { hashPassword } = await import("../../lib/server/auth/password");
  pwHash ??= hashPassword(PASSWORD);
  return pwHash;
}

export async function createAdmin(
  role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY",
  extra: { status?: "ACTIVE" | "SUSPENDED" } = {},
) {
  return db.platformAdmin.create({
    data: {
      email: `admin${next()}@example.com`,
      passwordHash: await passwordHash(),
      name: "관리자",
      role,
      status: extra.status ?? "ACTIVE",
    },
  });
}

// 마스터 로그인 입력(이메일 + 비밀번호, 2단계 인증 없음)
export const adminCredentials = (admin: { email: string }) => ({ email: admin.email, password: PASSWORD });

// 옛 역할 이름을 권한 묶음으로 쓴다(마이그레이션과 같은 매핑). 직접 권한을 주려면 permissions를 넘긴다.
export const STAFF_PRESETS = {
  MANAGER: [
    "BROADCAST_RUN",
    "OVERLAY_EDIT",
    "PRODUCT_MANAGE",
    "ORDER_SHIPPING",
    "CUSTOMER_PII_VIEW",
    "MEMBER_POINTS",
    "INQUIRY_REPLY",
    "RECEIPT_TAX",
    "SALES_VIEW",
  ],
  BROADCASTER: ["BROADCAST_RUN", "OVERLAY_EDIT"],
} as const;

export async function createSellerUser(
  sellerId: string,
  kind: "OWNER" | keyof typeof STAFF_PRESETS | { permissions: SellerStaffPermission[] },
  email?: string,
) {
  const isOwner = kind === "OWNER";
  const permissions = typeof kind === "object" ? kind.permissions : isOwner ? [] : [...STAFF_PRESETS[kind]];
  return db.sellerUser.create({
    data: { sellerId, email: email ?? `staff${next()}@example.com`, passwordHash: await passwordHash(), name: "직원", isOwner, permissions },
  });
}
export async function createLoginBuyer(sellerId: string, gradeId: string) {
  const m = await createBuyer(sellerId, gradeId);
  return db.buyerMember.update({ where: { id: m.id }, data: { passwordHash: await passwordHash() } });
}

// 휴대폰 본인확인(가짜 공급자) 테스트 도우미. 인적사항 기본값은 아래, 필요한 항목만 바꿔 쓴다.
export const IDV_INPUT = { name: "홍길동", phone: "01012345678", birth7: "9505051", carrier: "SKT", device: "MOBILE" } as const;
// 구매자 가입 본인확인 시작 본문에 함께 보내는 필수 동의(buyers/consent.ts). 재가입 제한을 켠 쇼핑몰은 REJOIN_CONSENT도.
export const SIGNUP_CONSENT = {
  agreedTerms: true,
  agreedPrivacy: true,
  termsVersion: SIGNUP_CONSENT_VERSIONS.terms,
  privacyVersion: SIGNUP_CONSENT_VERSIONS.privacy,
} as const;
// 파트너스 가입 본인확인 시작 본문에 함께 보내는 필수 동의(sellers/signupConsent.ts)
export const SELLER_SIGNUP_CONSENT = {
  agreedTerms: true,
  agreedPrivacy: true,
  termsVersion: SELLER_SIGNUP_CONSENT_VERSIONS.terms,
  privacyVersion: SELLER_SIGNUP_CONSENT_VERSIONS.privacy,
} as const;
export const REJOIN_CONSENT = { agreedRejoinRetention: true, rejoinRetentionVersion: SIGNUP_CONSENT_VERSIONS.rejoinRetention } as const;

// 시작 + 첫 인증번호 보내기
export async function startIdv(
  provider: IdentityProvider,
  input: { purpose: IdentityVerificationPurpose; sellerId: string | null; subjectId?: string | null; now?: Date; person?: Partial<IdentityPerson> },
) {
  const person: IdentityPerson = { ...IDV_INPUT, ...input.person };
  // 구매자·파트너스 가입용이면 본인확인 시작 때 받는 필수 동의를 함께 남긴다(실제 시작 API와 같게)
  const signupConsent =
    input.purpose === "BUYER_SIGNUP"
      ? { termsVersion: SIGNUP_CONSENT_VERSIONS.terms, privacyVersion: SIGNUP_CONSENT_VERSIONS.privacy, rejoinRetention: null, agreedAt: new Date().toISOString() }
      : input.purpose === "SELLER_REPRESENTATIVE"
        ? { termsVersion: SELLER_SIGNUP_CONSENT_VERSIONS.terms, privacyVersion: SELLER_SIGNUP_CONSENT_VERSIONS.privacy, agreedAt: new Date().toISOString() }
        : undefined;
  const started = await startIdentityVerification(db, provider, { ...input, person, signupConsent });
  const sent = await sendFirstIdentityCode(db, provider, started.verification, person, input.now);
  if (!sent.ok) throw new Error(sent.reason);
  return started;
}

// 가짜 공급자의 인증번호로 확인
export const confirmIdv = (
  provider: IdentityProvider,
  v: { id: string; sellerId: string | null; purpose: IdentityVerificationPurpose },
  ownerToken: string | undefined,
  code: string = FAKE_IDENTITY_OTP,
  now?: Date,
) => confirmIdentityCode(db, provider, v.id, { sellerId: v.sellerId, purpose: v.purpose, ownerToken }, code, now);

// 감사 로그 쓰기 실패 재현: 이 db로(트랜잭션 안팎 모두) action 감사 로그를 쓰면 예외를 던진다.
export function failingAudit(target: PrismaClient, action: string): PrismaClient {
  const wrapAudit = (audit: object) =>
    new Proxy(audit, {
      get(d, m, r) {
        const f = Reflect.get(d, m, r);
        if (m !== "create") return f;
        return (args: { data?: { action?: string } }) => {
          if (args?.data?.action === action) throw new Error(`감사 로그 쓰기 실패(테스트): ${action}`);
          return (f as (a: unknown) => unknown).call(d, args);
        };
      },
    });
  const wrap = (client: object) =>
    new Proxy(client, { get: (t, p, r) => (p === "auditLog" ? wrapAudit(Reflect.get(t, p, r)) : Reflect.get(t, p, r)) });
  return new Proxy(target, {
    get(t, p) {
      const v = Reflect.get(t, p);
      if (p === "auditLog") return wrapAudit(v);
      if (p === "$transaction") return (fn: (tx: object) => unknown, o?: unknown) => t.$transaction((tx) => fn(wrap(tx)) as Promise<unknown>, o as never);
      return typeof v === "function" ? v.bind(t) : v;
    },
  }) as PrismaClient;
}
