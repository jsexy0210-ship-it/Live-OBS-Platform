import { execFileSync } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as resetCompleteRoute } from "../../app/api/seller/password-reset/complete/route";
import { POST as resetConfirmRoute } from "../../app/api/seller/password-reset/confirm/route";
import { POST as resetStartRoute } from "../../app/api/seller/password-reset/start/route";
import { POST as resetVerifyRoute } from "../../app/api/seller/password-reset/verify/route";
import { GET as productsRoute } from "../../app/api/seller/products/route";
import { POST as cardRoute } from "../../app/api/seller/subscription/card/route";
import { POST as signupRoute } from "../../app/api/shop/[slug]/signup/route";
import { POST as confirmRoute } from "../../app/api/shop/[slug]/signup/verification/confirm/route";
import { POST as startRoute } from "../../app/api/shop/[slug]/signup/verification/route";
import { POST as findAccountsRoute } from "../../app/api/seller/find-id/accounts/route";
import { POST as findConfirmRoute } from "../../app/api/seller/find-id/confirm/route";
import { POST as findResetRoute } from "../../app/api/seller/find-id/reset/route";
import { POST as findStartRoute } from "../../app/api/seller/find-id/start/route";
import { POST as linkConfirmRoute } from "../../app/api/seller/me/identity/confirm/route";
import { POST as linkRoute } from "../../app/api/seller/me/identity/link/route";
import { POST as linkStartRoute } from "../../app/api/seller/me/identity/start/route";
import { POST as staffCreateRoute } from "../../app/api/seller/staff/route";
import { POST as applyRoute } from "../../app/api/seller-signup/apply/route";
import { POST as sellerConfirmRoute } from "../../app/api/seller-signup/verification/confirm/route";
import { POST as sellerStartRoute } from "../../app/api/seller-signup/verification/route";
import { loginAdmin, loginSeller } from "../../lib/server/auth/login";
import { sellerFeatures } from "../../lib/server/billing/features";
import { prisma } from "../../lib/server/db";
import { IDV_INPUT, SELLER_SIGNUP_CONSENT, SIGNUP_CONSENT, createSeller, db, resetDb } from "./helpers";

beforeEach(async () => {
  vi.unstubAllEnvs();
  await resetDb();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const post = (url: string, body: unknown, cookie?: string) =>
  new Request(`http://localhost:3000${url}`, { method: "POST", headers: { ...H, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const cookieOf = (res: Response, name: string) => (res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`)) ?? "").split(";")[0];

// 서버에서처럼 운영 빌드(NODE_ENV=production)로 시험 데이터 명령을 돌린다. 아이디·비밀번호는 환경변수로만 넘긴다.
function seed(extra: Record<string, string>) {
  try {
    const out = execFileSync("node", ["scripts/seed-obs-test.mjs"], {
      env: { PATH: process.env.PATH, DATABASE_URL: process.env.DATABASE_URL, NODE_ENV: "production", ...extra },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
}
const HASH_KEY = "test-identity-hash-key-0123456789abcdef";
const SEED = { SEED_SELLER_LOGIN: "test", SEED_SELLER_PASSWORD: "1234", IDENTITY_HASH_KEY: HASH_KEY };

describe("테스트 서버 시험 데이터 명령(scripts/seed-obs-test.mjs)", () => {
  it("OBS_TEST_MODE=1이 없으면 운영 빌드에서 아무것도 넣지 않고 실패한다", () => {
    const r = seed(SEED);
    expect(r.code).toBe(1);
    expect(r.out).toContain("OBS_TEST_MODE=1");
    return expect(db.seller.count()).resolves.toBe(0);
  });

  it("아이디 test·비밀번호 1234로 대표자 계정·시험 쇼핑몰·상품을 만들고 그 계정으로 로그인된다. 다시 실행해도 늘지 않고, 출력에 비밀번호가 없다", async () => {
    const first = seed({ OBS_TEST_MODE: "1", ...SEED });
    expect(first.code).toBe(0);
    expect(first.out).not.toContain("1234");
    const shop = await db.seller.findUniqueOrThrow({ where: { slug: "test-shop" }, include: { users: true, grades: true } });
    expect(shop).toMatchObject({ status: "ACTIVE", shopName: "테스트 쇼핑몰" });
    expect(shop.users).toHaveLength(1);
    expect(shop.users[0]).toMatchObject({ email: "test", isOwner: true, status: "ACTIVE" });
    expect(shop.grades).toHaveLength(5);
    expect(await db.product.count({ where: { sellerId: shop.id } })).toBe(3);
    // 처음 재고는 상품 등록처럼 재고 이동(MANUAL, 「처음 재고」)으로 남고, 이동 합계·마지막 stockAfter가 표시 재고와 같다
    const options = await db.productOption.findMany({ where: { sellerId: shop.id } });
    expect(options).toHaveLength(4);
    for (const o of options) {
      const moves = await db.stockMovement.findMany({ where: { optionId: o.id } });
      expect(moves.map((m) => [m.reason, m.note, m.delta, m.actorId])).toEqual([["MANUAL", "처음 재고", o.stock, shop.users[0].id]]);
      expect(moves[0].stockAfter).toBe(o.stock);
    }
    const login = await loginSeller(db, { email: "test", password: "1234" }, {});
    expect(login.ok).toBe(true);

    const counts = async () => [await db.seller.count(), await db.sellerUser.count(), await db.product.count(), await db.productOption.count()];
    const before = await counts();
    const again = seed({ OBS_TEST_MODE: "1", ...SEED });
    expect(again.code).toBe(0);
    expect(again.out).toContain("이미 판매자가 있어");
    expect(await counts()).toEqual(before);
  });

  it("판매자가 이미 있으면 아무것도 하지 않고, 아이디·비밀번호나 본인확인 해시 키가 없으면 실패한다", async () => {
    expect(seed({ OBS_TEST_MODE: "1" }).code).toBe(1);
    const noKey = seed({ OBS_TEST_MODE: "1", ...SEED, IDENTITY_HASH_KEY: "" });
    expect(noKey.code).toBe(1);
    expect(noKey.out).toContain("IDENTITY_HASH_KEY");
    expect(await db.seller.count()).toBe(0);
    await createSeller();
    const r = seed({ OBS_TEST_MODE: "1", ...SEED });
    expect(r.code).toBe(0);
    expect(await db.sellerUser.count({ where: { email: "test" } })).toBe(0);
  });

  // 마스터 관리자(최고관리자) 시험 계정(대표님 지시 2026-10-04). 아이디 형식·비밀번호 길이 규칙은 이 명령에서만 건너뛴다.
  const ADMIN = { SEED_ADMIN_LOGIN: "master", SEED_ADMIN_PASSWORD: "9876" };
  const adminLogin = () => loginAdmin(db, { email: "master", password: "9876" }, {});

  it("관리자만: 본인확인 해시 키 없이 최고관리자 계정만 만들고 그 계정으로 로그인된다. 판매자는 만들지 않고, 출력에 비밀번호가 없다", async () => {
    const r = seed({ OBS_TEST_MODE: "1", ...ADMIN });
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("9876");
    expect(await db.platformAdmin.findMany({ select: { email: true, name: true, role: true, status: true } })).toEqual([
      { email: "master", name: "최고관리자", role: "SUPER_ADMIN", status: "ACTIVE" },
    ]);
    expect((await adminLogin()).ok).toBe(true);
    expect(await db.seller.count()).toBe(0);
  });

  it("둘 다: 판매자·관리자를 함께 만든다. 같은 관리자로 다시 실행하면 만들지 않고 알린다(비밀번호도 바꾸지 않음)", async () => {
    expect(seed({ OBS_TEST_MODE: "1", ...SEED, ...ADMIN }).code).toBe(0);
    expect(await db.sellerUser.count({ where: { email: "test" } })).toBe(1);
    expect(await db.platformAdmin.count()).toBe(1);
    const again = seed({ OBS_TEST_MODE: "1", ...SEED, SEED_ADMIN_LOGIN: "master", SEED_ADMIN_PASSWORD: "other" });
    expect(again.code).toBe(0);
    expect(again.out).toContain("이미 같은 아이디의 마스터 관리자가 있어");
    expect(await db.platformAdmin.count()).toBe(1);
    expect((await adminLogin()).ok).toBe(true);
  });

  it("판매자가 이미 있으면 판매자 부분만 건너뛰고 관리자 생성은 계속한다. 아이디·비밀번호 한쪽만 있으면 아무것도 하지 않고 실패한다", async () => {
    await createSeller();
    const r = seed({ OBS_TEST_MODE: "1", ...SEED, ...ADMIN });
    expect(r.code).toBe(0);
    expect(r.out).toContain("이미 판매자가 있어");
    expect(await db.sellerUser.count({ where: { email: "test" } })).toBe(0);
    expect(await db.platformAdmin.count()).toBe(1);

    const halves: Record<string, string>[] = [{ SEED_ADMIN_LOGIN: "other" }, { SEED_ADMIN_PASSWORD: "x" }, { SEED_SELLER_LOGIN: "x", ...ADMIN }];
    for (const half of halves) {
      const bad = seed({ OBS_TEST_MODE: "1", IDENTITY_HASH_KEY: HASH_KEY, ...half });
      expect(bad.code, JSON.stringify(half)).toBe(1);
    }
    expect(await db.platformAdmin.count()).toBe(1);
    // OBS_TEST_MODE=1 가드는 관리자에도 그대로
    expect(seed({ SEED_ADMIN_LOGIN: "other", SEED_ADMIN_PASSWORD: "x" }).code).toBe(1);
    expect(await db.platformAdmin.count()).toBe(1);
  });
});

describe("테스트 서버 모드: 운영 빌드에서 본인확인 우회", () => {
  it("플래그가 없는 운영 빌드는 본인확인이 503, 플래그가 있으면 가짜 공급자(인증번호 000000)로 가입·비밀번호 찾기 시작이 된다", async () => {
    const { seller } = await createSeller();
    const base = `/api/shop/${seller.slug}/signup`;
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("IDENTITY_HASH_KEY", "test-identity-hash-key-0123456789abcdef");
    for (const k of ["PORTONE_API_SECRET", "PORTONE_STORE_ID", "PORTONE_IDENTITY_CHANNEL_KEY"]) vi.stubEnv(k, "");
    expect((await startRoute(post(`${base}/verification`, IDV_INPUT), ctx(seller.slug))).status).toBe(503);
    expect((await resetStartRoute(post("/api/seller/password-reset/start", { email: "owner@example.com", shopSlug: seller.slug, person: IDV_INPUT }))).status).toBe(503);

    vi.stubEnv("OBS_TEST_MODE", "1");
    // 구매자 가입 본인확인 시작은 필수 동의를 함께 받는다(#147)
    const start = await startRoute(post(`${base}/verification`, { ...IDV_INPUT, ...SIGNUP_CONSENT }), ctx(seller.slug));
    expect(start.status).toBe(200);
    const cookie = cookieOf(start, "lo_bidv");
    const { verificationId } = await start.json();
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: verificationId } })).provider).toBe("fake");
    const confirmed = await confirmRoute(post(`${base}/verification/confirm`, { verificationId, code: "000000" }, cookie), ctx(seller.slug));
    expect(confirmed.status, JSON.stringify(await confirmed.clone().json())).toBe(200);
    const signup = await signupRoute(
      post(base, { verificationId, loginId: "buyer@example.com", password: "pw-123456", broadcastNickname: "테스트", agreedTerms: true, agreedPrivacy: true }, cookie),
      ctx(seller.slug),
    );
    expect(signup.status).toBe(201);
    expect((await resetStartRoute(post("/api/seller/password-reset/start", { email: "owner@example.com", shopSlug: seller.slug, person: IDV_INPUT }))).status).not.toBe(503);
  });
});

describe("테스트 서버 모드: 시험 대표자 계정의 비밀번호 찾기", () => {
  it("시드가 안내한 시험 인물(이름·생년월일)과 인증번호 000000으로 본인확인하면 대표자로 확인돼 새 비밀번호로 로그인된다. 다른 사람이면 거부", async () => {
    const out = seed({ OBS_TEST_MODE: "1", ...SEED });
    expect(out.code).toBe(0);
    expect(out.out).toContain("이름 테스트대표");
    expect(out.out).toContain("인증번호 000000");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("IDENTITY_HASH_KEY", HASH_KEY);
    vi.stubEnv("OBS_TEST_MODE", "1");
    for (const k of ["PORTONE_API_SECRET", "PORTONE_STORE_ID", "PORTONE_IDENTITY_CHANNEL_KEY"]) vi.stubEnv(k, "");
    const flow = async (person: Record<string, string>) => {
      const s = await resetStartRoute(post("/api/seller/password-reset/start", { email: "test", shopSlug: "test-shop", person }));
      expect(s.status).toBe(200);
      const cookie = cookieOf(s, "lo_idv");
      const { verificationId } = await s.json();
      expect((await resetConfirmRoute(post("/api/seller/password-reset/confirm", { verificationId, code: "000000" }, cookie))).status).toBe(200);
      return resetVerifyRoute(post("/api/seller/password-reset/verify", { verificationId }, cookie));
    };
    // 다른 사람(홍길동)은 대표자 CI와 달라 거부
    expect((await flow(IDV_INPUT)).status).toBe(400);
    const v = await flow({ ...IDV_INPUT, name: "테스트대표", birth7: "9001011" });
    expect(v.status).toBe(200);
    const grant = cookieOf(v, "lo_pwreset");
    expect((await resetCompleteRoute(post("/api/seller/password-reset/complete", { newPassword: "new-pass-5678" }, grant))).status).toBe(200);
    expect((await loginSeller(db, { email: "test", password: "new-pass-5678" }, {})).ok).toBe(true);
  });
});

describe("테스트 서버 모드: 바뀐 본인확인 흐름(아이디 찾기·직원 연결·가입 재개)", () => {
  const testServer = () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("IDENTITY_HASH_KEY", HASH_KEY);
    vi.stubEnv("OBS_TEST_MODE", "1");
    for (const k of ["PORTONE_API_SECRET", "PORTONE_STORE_ID", "PORTONE_IDENTITY_CHANNEL_KEY"]) vi.stubEnv(k, "");
  };
  const REP = { ...IDV_INPUT, name: "테스트대표", birth7: "9001011" };

  it("아이디 찾기: 시험 인물로 확인하면 시험 대표자 계정이 나오고, 재설정 권한(응답을 잃은 재시도도 같은 권한)으로 새 비밀번호가 된다", async () => {
    expect(seed({ OBS_TEST_MODE: "1", ...SEED }).code).toBe(0);
    testServer();
    const s = await findStartRoute(post("/api/seller/find-id/start", REP));
    expect(s.status).toBe(200);
    const flow = cookieOf(s, "lo_fidv");
    const { verificationId } = await s.json();
    expect((await findConfirmRoute(post("/api/seller/find-id/confirm", { verificationId, code: "000000" }, flow))).status).toBe(200);
    const { accounts } = await (await findAccountsRoute(post("/api/seller/find-id/accounts", { verificationId, accountType: "owner" }, flow))).json();
    expect(accounts.map((a: { email: string; shopSlug: string }) => [a.email, a.shopSlug])).toEqual([["test", "test-shop"]]);
    const reset = () => findResetRoute(post("/api/seller/find-id/reset", { verificationId, accountType: "owner", accountId: accounts[0].accountId }, flow));
    const first = await reset();
    const again = await reset();
    expect([first.status, again.status]).toEqual([200, 200]);
    expect(cookieOf(again, "lo_pwreset")).toBe(cookieOf(first, "lo_pwreset"));
    expect((await resetCompleteRoute(post("/api/seller/password-reset/complete", { newPassword: "found-pass-5678" }, cookieOf(first, "lo_pwreset")))).status).toBe(200);
    expect((await loginSeller(db, { email: "test", password: "found-pass-5678" }, {})).ok).toBe(true);
  });

  it("직원 연결: 시험 대표자가 만든 직원이 인증번호 000000으로 본인확인을 연결한다", async () => {
    expect(seed({ OBS_TEST_MODE: "1", ...SEED }).code).toBe(0);
    testServer();
    const owner = await loginSeller(db, { email: "test", password: "1234" }, {});
    if (!owner.ok) throw new Error(owner.reason);
    const created = await staffCreateRoute(post("/api/seller/staff", { email: "staff@example.com", name: "시험직원", password: "staff-pass-1234", permissions: [], phone: IDV_INPUT.phone }, `lo_seller=${owner.token}`));
    expect(created.status).toBe(201);
    const staff = await loginSeller(db, { email: "staff@example.com", password: "staff-pass-1234" }, {});
    if (!staff.ok) throw new Error(staff.reason);
    const session = `lo_seller=${staff.token}`;
    const s = await linkStartRoute(post("/api/seller/me/identity/start", { ...IDV_INPUT, name: "시험직원" }, session));
    expect(s.status).toBe(200);
    const flow = cookieOf(s, "lo_lidv");
    const { verificationId } = await s.json();
    expect((await linkConfirmRoute(post("/api/seller/me/identity/confirm", { verificationId, code: "000000" }, flow))).status).toBe(200);
    expect((await linkRoute(post("/api/seller/me/identity/link", { verificationId }, `${session}; ${flow}`))).status).toBe(200);
    expect((await db.sellerUser.findFirstOrThrow({ where: { email: "staff@example.com" } })).identityCiHash).not.toBeNull();
  });

  it("파트너스 가입: 인증번호 000000으로 신청하고, 응답을 잃은 뒤 본인확인 유효 시간이 지나 다시 보내도 같은 신청(resumed)을 받는다", async () => {
    testServer();
    const person = { ...IDV_INPUT, name: "가입대표", birth7: "8505051" };
    const s = await sellerStartRoute(post("/api/seller-signup/verification", { ...person, ...SELLER_SIGNUP_CONSENT, attemptKey: "0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f" }));
    expect(s.status).toBe(200);
    const flow = cookieOf(s, "lo_sidv");
    const { verificationId } = await s.json();
    expect((await sellerConfirmRoute(post("/api/seller-signup/verification/confirm", { verificationId, code: "000000" }, flow))).status).toBe(200);
    const body = {
      verificationId, email: "partner@example.com", password: "partner-pass-1", shopName: "가입 쇼핑몰", slug: "join-shop",
      businessNumber: "124-81-00998", companyName: "가입 상사", openedOn: "20200101", mailOrderNumber: "제2025-부산해운대-00077호",
    };
    const first = await applyRoute(post("/api/seller-signup/apply", body, flow));
    expect(first.status).toBe(200);
    expect((await first.json()).resumed).toBe(false);
    await db.identityVerification.update({ where: { id: verificationId }, data: { verifiedAt: new Date(Date.now() - 15 * 60_000), expiresAt: new Date(Date.now() - 60_000) } });
    const late = await applyRoute(post("/api/seller-signup/apply", body, flow));
    expect(late.status).toBe(200);
    expect((await late.json()).resumed).toBe(true);
    expect(await db.seller.count({ where: { slug: "join-shop" } })).toBe(1);
  });
});

describe("테스트 서버 모드: 운영 빌드에서 구독 결제 우회", () => {
  it("플래그가 없는 운영 빌드는 가짜 결제를 쓸 수 없고(결제 기록 없음), 플래그가 있으면 실제 결제 없이 카드 등록·결제가 성공하고 결제 번호에 fake가 붙는다", async () => {
    expect(seed({ OBS_TEST_MODE: "1", ...SEED }).code).toBe(0);
    // 체험이 끝난 쇼핑몰(카드 등록 뒤 바로 결제)
    await db.seller.update({ where: { slug: "test-shop" }, data: { trialEndsAt: new Date(Date.now() - 86_400_000) } });
    const login = await loginSeller(db, { email: "test", password: "1234" }, {});
    if (!login.ok) throw new Error(login.reason);
    const cookie = `lo_seller=${login.token}`;
    const card = () => cardRoute(post("/api/seller/subscription/card", { authKey: "test-card" }, cookie));

    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("BILLING_KEY_SECRET", "test-billing-key-secret-0123456789abcdef");
    vi.stubEnv("BILLING_PROVIDER", "");
    expect((await card()).status).toBe(500);
    expect(await db.subscriptionPayment.count()).toBe(0);

    vi.stubEnv("OBS_TEST_MODE", "1");
    const paid = await card();
    expect(paid.status).toBe(200);
    const payment = await db.subscriptionPayment.findFirstOrThrow();
    expect(payment).toMatchObject({ status: "PAID", amount: 179000 }); // 시험 쇼핑몰은 쇼핑몰 통합(ONQ 1-C) 런칭가
    expect(payment.providerPaymentId).toMatch(/^fake-pay-/);
  });

  it("새 파트너스(기본 플랜 통합, 체험 없음): 첫 결제 전에는 상품 API가 막히고, 테스트 서버 모드 우회로 첫 결제 179,000원이 확정되면 기능이 모두 열린다(ONQ 1-C)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("IDENTITY_HASH_KEY", HASH_KEY);
    vi.stubEnv("OBS_TEST_MODE", "1");
    for (const k of ["PORTONE_API_SECRET", "PORTONE_STORE_ID", "PORTONE_IDENTITY_CHANNEL_KEY"]) vi.stubEnv(k, "");
    vi.stubEnv("BILLING_KEY_SECRET", "test-billing-key-secret-0123456789abcdef");
    vi.stubEnv("BILLING_PROVIDER", "");
    const s = await sellerStartRoute(post("/api/seller-signup/verification", { ...IDV_INPUT, name: "통합대표", birth7: "8505051", ...SELLER_SIGNUP_CONSENT }));
    expect(s.status).toBe(200);
    const flow = cookieOf(s, "lo_sidv");
    const { verificationId } = await s.json();
    expect((await sellerConfirmRoute(post("/api/seller-signup/verification/confirm", { verificationId, code: "000000" }, flow))).status).toBe(200);
    const applied = await applyRoute(
      post(
        "/api/seller-signup/apply",
        {
          verificationId, email: "new@example.com", password: "partner-pass-1", shopName: "새 쇼핑몰", slug: "new-shop",
          businessNumber: "124-81-00998", companyName: "새 상사", openedOn: "20200101", mailOrderNumber: "제2025-부산해운대-00077호",
        },
        flow,
      ),
    );
    expect(applied.status).toBe(200);
    const seller = await db.seller.findUniqueOrThrow({ where: { slug: "new-shop" }, include: { plan: true } });
    if (seller.status === "PENDING") await db.seller.update({ where: { id: seller.id }, data: { status: "ACTIVE", approvedAt: new Date() } });
    expect(seller.plan?.code).toBe("INTEGRATED");
    expect(seller.trialEndsAt).toBeNull();
    expect(await sellerFeatures(db, seller.id)).toEqual([]);
    const login = await loginSeller(db, { email: "new@example.com", password: "partner-pass-1" }, {});
    if (!login.ok) throw new Error(login.reason);
    const cookie = `lo_seller=${login.token}`;
    const products = () => productsRoute(new Request("http://localhost:3000/api/seller/products", { headers: { host: "localhost:3000", cookie } }));
    expect((await products()).status).toBe(402);

    const paid = await cardRoute(post("/api/seller/subscription/card", { authKey: "test-card" }, cookie));
    expect(paid.status).toBe(200);
    const payment = await db.subscriptionPayment.findFirstOrThrow({ where: { sellerId: seller.id } });
    expect(payment).toMatchObject({ status: "PAID", amount: 179000 });
    expect(payment.providerPaymentId).toMatch(/^fake-pay-/);
    expect(await sellerFeatures(db, seller.id)).toEqual(["OVERLAY", "EXTERNAL_INTEGRATION", "STORE_OPERATIONS"]);
    expect((await products()).status).toBe(200);
  });
});
