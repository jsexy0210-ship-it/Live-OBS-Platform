import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as checkRoute } from "../../app/api/seller/integration-profile/business-check/route";
import { GET as profileGet, PUT as profilePut } from "../../app/api/seller/integration-profile/route";
import { POST as planRoute } from "../../app/api/seller/subscription/plan/route";
import { loginSeller } from "../../lib/server/auth/login";
import { changePlan, previewPlanChanges } from "../../lib/server/billing/planChange";
import { FakeBillingProvider } from "../../lib/server/billing/provider";
import { prisma } from "../../lib/server/db";
import { businessStatusProvider, FakeBusinessStatusProvider } from "../../lib/server/sellers/businessCheck";
import { BUSINESS_CHECK_DAILY_LIMIT, openSettlementAccount } from "../../lib/server/sellers/integrationProfile";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, completeIntegrationProfile, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// SA-005 쇼핑몰 통합 전환 서버: 사업자·정산 정보 저장·조회(계좌번호 암호화·마스킹), 로그인 사업자 상태 조회(하루 횟수 제한), 상위 변경 게이트.
beforeAll(() => {
  process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef";
  process.env.BILLING_PROVIDER = "fake";
  process.env.BUSINESS_STATUS_PROVIDER = "fake";
});
let plans: Awaited<ReturnType<typeof seedPlans>>;
beforeEach(async () => {
  await resetDb();
  plans = await seedPlans();
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { "content-type": "application/json", host: "localhost:3000", origin: BASE };
const BN = "1234567891"; // 검증 숫자가 맞는 사업자등록번호
const FAILING_BN = "2208162517"; // 조회 실패를 걸어 두는 번호(공급자 가짜 객체는 시험 사이에 이어지므로 다른 시험과 겹치지 않게)
const PROFILE = { companyName: "별빛카드", representativeName: "김대표", businessNumber: "123-45-67891", businessAddress: "서울시 강남구 1", bankName: "국민은행", accountNumber: "123-456-789012", accountHolder: "김대표" };

async function shop(planCode: "OVERLAY_ONLY" | "INTEGRATED" = "OVERLAY_ONLY", businessInfo?: Record<string, unknown>) {
  const { seller } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { planId: plans[planCode].id, trialEndsAt: null, ...(businessInfo ? { businessInfo: businessInfo as never } : {}) } });
  const owner = await createSellerUser(seller.id, "OWNER");
  const staff = await createSellerUser(seller.id, { permissions: ["SHOP_SETTINGS"] });
  const login = async (email: string) => {
    const r = await loginSeller(db, { email, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    return `lo_seller=${r.token}`;
  };
  const cookie = await login(owner.email);
  const staffCookie = await login(staff.email);
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const get = (c = cookie) => profileGet(new Request(`${BASE}/api/seller/integration-profile`, { headers: { ...H, ...(c ? { cookie: c } : {}) } }));
  const put = (body: unknown, c = cookie) => profilePut(new Request(`${BASE}/api/seller/integration-profile`, { method: "PUT", headers: { ...H, ...(c ? { cookie: c } : {}) }, body: JSON.stringify(body) }));
  const check = (body: unknown, c = cookie) => checkRoute(new Request(`${BASE}/api/seller/integration-profile/business-check`, { method: "POST", headers: { ...H, ...(c ? { cookie: c } : {}) }, body: JSON.stringify(body) }));
  return { seller, owner, ctx, cookie, staffCookie, get, put, check };
}

describe("사업자·정산 정보 저장·조회", () => {
  it("저장한 적 없으면 빈 값(통합 가입 계정은 신청 때 받은 사업자 정보로 미리 채움)이고 완료가 아니다. 로그인 없음 401, 구독 관리 권한 없는 직원 403", async () => {
    const s = await shop("OVERLAY_ONLY");
    expect(await (await s.get()).json()).toMatchObject({ business: { companyName: "", representativeName: "", businessNumber: "", mailOrderNumber: null, businessAddress: "" }, settlement: null, complete: false, businessCheck: { status: "unchecked", checkedAt: null } });
    const t = await shop("INTEGRATED", { businessNumber: BN, representativeName: "김대표", mailOrderNumber: "제2024-서울강남-01234호", openedOn: "20200101" });
    expect((await (await t.get()).json()).business).toMatchObject({ businessNumber: BN, representativeName: "김대표", mailOrderNumber: "제2024-서울강남-01234호", companyName: "" });
    expect((await s.get("")).status).toBe(401);
    expect((await s.get(s.staffCookie)).status).toBe(403);
    expect((await s.put(PROFILE, s.staffCookie)).status).toBe(403);
  });

  it("저장하면 계좌번호는 암호문으로만 남고(다른 쇼핑몰·용도로는 풀리지 않음) 응답은 뒤 4자리 마스킹, 로그 추적에도 원문이 없다", async () => {
    const s = await shop();
    const r = await s.put({ ...PROFILE, mailOrderNumber: "제2024-서울강남-01234호" });
    expect(r.status).toBe(200);
    const body = await (await s.get()).json();
    expect(body).toMatchObject({
      business: { companyName: "별빛카드", representativeName: "김대표", businessNumber: BN, mailOrderNumber: "제2024-서울강남-01234호", businessAddress: "서울시 강남구 1" },
      settlement: { bankName: "국민은행", accountNumberMasked: "****9012", accountHolder: "김대표" },
      complete: true,
    });
    expect(JSON.stringify(body)).not.toContain("123456789012");
    const row = await db.sellerIntegrationProfile.findUniqueOrThrow({ where: { sellerId: s.seller.id } });
    expect(row.accountCipher).toBeTruthy();
    expect(row.accountCipher).not.toContain("123456789012");
    expect(openSettlementAccount(row.accountCipher!, s.seller.id)).toBe("123456789012");
    const otherSeller = (await createSeller()).seller;
    expect(() => openSettlementAccount(row.accountCipher!, otherSeller.id)).toThrow();
    const audits = await db.auditLog.findMany({ where: { sellerId: s.seller.id, action: "seller.integration_profile.update" } });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0])).not.toContain("123456789012");
    expect(JSON.stringify(audits[0])).not.toContain(BN);
    // 예금주가 상호와 같아도 된다
    expect((await s.put({ ...PROFILE, accountHolder: "별빛카드" })).status).toBe(200);
  });

  it("틀린 값은 400이고 저장되지 않는다: 예금주 불일치·사업자번호 검증 숫자·계좌번호 형식·필수 누락·통신판매업 번호 형식", async () => {
    const s = await shop();
    const bad = async (over: Record<string, unknown>, error: string) => {
      const r = await s.put({ ...PROFILE, ...over });
      expect([r.status, (await r.json()).error]).toEqual([400, error]);
    };
    await bad({ accountHolder: "홍길동" }, "holder_mismatch");
    await bad({ businessNumber: "1234567890" }, "invalid_business_number");
    await bad({ businessNumber: undefined }, "invalid_business_number");
    await bad({ accountNumber: "12345" }, "invalid_account_number");
    await bad({ accountNumber: "가나다라마바사아" }, "invalid_account_number");
    await bad({ companyName: "" }, "invalid_profile");
    await bad({ businessAddress: undefined }, "invalid_profile");
    await bad({ bankName: "" }, "invalid_profile");
    await bad({ mailOrderNumber: "abc" }, "invalid_profile");
    expect(await db.sellerIntegrationProfile.count()).toBe(0);
  });

  it("BILLING_KEY_SECRET이 없으면 503 secret_missing이고 저장되지 않는다", async () => {
    const s = await shop();
    const saved = process.env.BILLING_KEY_SECRET;
    delete process.env.BILLING_KEY_SECRET;
    try {
      const r = await s.put(PROFILE);
      expect([r.status, (await r.json()).error]).toEqual([503, "secret_missing"]);
    } finally {
      process.env.BILLING_KEY_SECRET = saved;
    }
    expect(await db.sellerIntegrationProfile.count()).toBe(0);
  });
});

describe("사업자 상태 조회", () => {
  it("개업일자를 보내면 조회하고 결과(상태·진위)를 돌려주며, 다르면 valid=false·정지·폐업·없음 상태도 그대로", async () => {
    const s = await shop();
    const provider = businessStatusProvider() as FakeBusinessStatusProvider;
    provider.register(BN, { representativeName: "김대표", openedOn: "20200101" });
    const ok = await s.check({ businessNumber: "123-45-67891", representativeName: "김대표", openedOn: "2020-01-01" });
    expect([ok.status, await ok.json()]).toEqual([200, { status: "ACTIVE", valid: true }]);
    const wrongName = await s.check({ businessNumber: BN, representativeName: "박대표", openedOn: "20200101" });
    expect(await wrongName.json()).toEqual({ status: "ACTIVE", valid: false });
    provider.set(BN, "CLOSED");
    expect(await (await s.check({ businessNumber: BN, representativeName: "김대표", openedOn: "20200101" })).json()).toEqual({ status: "CLOSED", valid: true });
  });

  it("개업일자가 없으면 신청 때 받은 개업일자를 쓰고, 그것도 없으면 400 opened_on_required. 형식이 틀리면 400", async () => {
    const overlay = await shop("OVERLAY_ONLY");
    const r = await overlay.check({ businessNumber: BN, representativeName: "김대표" });
    expect([r.status, (await r.json()).error]).toEqual([400, "opened_on_required"]);
    expect((await (await overlay.check({ businessNumber: BN, representativeName: "김대표", openedOn: "2020-13-45" })).json()).error).toBe("invalid_opened_on");
    expect((await (await overlay.check({ businessNumber: "1234567890", representativeName: "김대표", openedOn: "20200101" })).json()).error).toBe("invalid_business_number");
    const signed = await shop("INTEGRATED", { businessNumber: BN, representativeName: "김대표", openedOn: "20200101" });
    expect((await signed.check({ businessNumber: BN, representativeName: "김대표" })).status).toBe(200);
    // 신청한 사업자번호와 다른 번호에는 그 개업일자를 쓰지 않는다
    expect((await (await signed.check({ businessNumber: "2208162517", representativeName: "김대표" })).json()).error).toBe("opened_on_required");
  });

  it(`조회 실패는 502(횟수에는 셈), 하루 ${BUSINESS_CHECK_DAILY_LIMIT}번을 넘으면 429이고 공급자를 부르지 않는다`, async () => {
    const s = await shop();
    const provider = businessStatusProvider() as FakeBusinessStatusProvider;
    provider.fail(FAILING_BN);
    const body = { businessNumber: FAILING_BN, representativeName: "김대표", openedOn: "20200101" };
    const failed = await s.check(body);
    expect([failed.status, (await failed.json()).error]).toEqual([502, "lookup_failed"]);
    for (let i = 1; i < BUSINESS_CHECK_DAILY_LIMIT; i++) await s.check(body);
    const over = await s.check(body);
    expect([over.status, (await over.json()).error]).toEqual([429, "daily_limit_exceeded"]);
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: "seller.integration.business_check" } })).toBe(BUSINESS_CHECK_DAILY_LIMIT);
    // 다른 쇼핑몰은 영향 없음
    const other = await shop();
    provider.register("1048100335", { representativeName: "김대표" });
    expect((await other.check({ businessNumber: "1048100335", representativeName: "김대표", openedOn: "20200101" })).status).toBe(200);
  });

  it("조회 결과는 저장된 사업자번호·대표자명에 묶이고, 둘 중 하나를 바꿔 저장하면 지워진다", async () => {
    const s = await shop();
    const provider = businessStatusProvider() as FakeBusinessStatusProvider;
    provider.register(BN, { representativeName: "김대표" });
    await s.check({ businessNumber: BN, representativeName: "김대표", openedOn: "20200101" });
    await s.put(PROFILE);
    expect((await (await s.get()).json()).businessCheck.status).toBe("ok");
    // 같은 사업자 정보(주소·계좌만 바꿈)는 조회 결과를 유지
    await s.put({ ...PROFILE, businessAddress: "서울시 서초구 2" });
    expect((await (await s.get()).json()).businessCheck.status).toBe("ok");
    // 대표자명이 바뀌면 지운다
    await s.put({ ...PROFILE, representativeName: "박대표", accountHolder: "박대표" });
    expect((await (await s.get()).json()).businessCheck.status).toBe("unchecked");
    expect((await db.sellerIntegrationProfile.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).checkStatus).toBeNull();
  });
});

describe("상위 변경 게이트(오버레이 전용 → 통합)", () => {
  const upgrade = (s: Awaited<ReturnType<typeof shop>>) => changePlan(db, new FakeBillingProvider(), s.ctx, { planCode: "INTEGRATED" });

  it("정보가 비어 있으면 profile_incomplete, 조회 전·24시간 뒤·사업자번호 변경 뒤면 business_unchecked, 정지·불일치면 business_not_active, 모두 맞으면 통과한다", async () => {
    const s = await shop();
    expect(await upgrade(s)).toEqual({ ok: false, reason: "profile_incomplete" });
    await completeIntegrationProfile(s.seller.id, { checkStatus: null, checkValid: null, checkedAt: null, checkBusinessNumber: null, checkRepresentativeName: null });
    expect(await upgrade(s)).toEqual({ ok: false, reason: "business_unchecked" });
    await completeIntegrationProfile(s.seller.id, { checkedAt: new Date(Date.now() - 25 * 3_600_000) });
    expect(await upgrade(s)).toEqual({ ok: false, reason: "business_unchecked" });
    await completeIntegrationProfile(s.seller.id, { checkBusinessNumber: "2208162517" });
    expect(await upgrade(s)).toEqual({ ok: false, reason: "business_unchecked" });
    await completeIntegrationProfile(s.seller.id, { checkBusinessNumber: BN, checkStatus: "SUSPENDED" });
    expect(await upgrade(s)).toEqual({ ok: false, reason: "business_not_active" });
    await completeIntegrationProfile(s.seller.id, { checkStatus: "ACTIVE", checkValid: false });
    expect(await upgrade(s)).toEqual({ ok: false, reason: "business_not_active" });
    expect((await db.subscriptionPlan.findUniqueOrThrow({ where: { id: (await db.seller.findUniqueOrThrow({ where: { id: s.seller.id } })).planId! } })).code).toBe("OVERLAY_ONLY");
    await completeIntegrationProfile(s.seller.id, { checkValid: true });
    expect(await upgrade(s)).toMatchObject({ ok: true, planCode: "INTEGRATED" });
  });

  it("미리보기도 같은 사유를 보여 주고, HTTP는 400 profile_incomplete·409로 거절한다. 통합→오버레이 전용(하위)·같은 플랜에는 게이트가 없다", async () => {
    const s = await shop();
    const preview = await previewPlanChanges(db, s.ctx);
    expect(preview.plans.find((p) => p.planCode === "INTEGRATED")!.change).toEqual({ ok: false, reason: "profile_incomplete" });
    const r = await planRoute(new Request(`${BASE}/api/seller/subscription/plan`, { method: "POST", headers: { ...H, cookie: s.cookie }, body: JSON.stringify({ planCode: "INTEGRATED", expectedAmount: 0 }) }));
    expect([r.status, (await r.json()).error]).toEqual([400, "profile_incomplete"]);
    await completeIntegrationProfile(s.seller.id, { checkValid: false });
    const r2 = await planRoute(new Request(`${BASE}/api/seller/subscription/plan`, { method: "POST", headers: { ...H, cookie: s.cookie }, body: JSON.stringify({ planCode: "INTEGRATED", expectedAmount: 0 }) }));
    expect([r2.status, (await r2.json()).error]).toEqual([409, "business_not_active"]);
    const t = await shop("INTEGRATED");
    expect(await changePlan(db, new FakeBillingProvider(), t.ctx, { planCode: "OVERLAY_ONLY" })).toMatchObject({ ok: true });
    const u = await shop("INTEGRATED");
    expect(await changePlan(db, new FakeBillingProvider(), u.ctx, { planCode: "INTEGRATED" })).toEqual({ ok: false, reason: "same_plan" });
  });
});
