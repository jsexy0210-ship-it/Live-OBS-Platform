import { execFileSync } from "node:child_process";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as resetCompleteRoute } from "../../app/api/seller/password-reset/complete/route";
import { POST as resetConfirmRoute } from "../../app/api/seller/password-reset/confirm/route";
import { POST as resetStartRoute } from "../../app/api/seller/password-reset/start/route";
import { POST as resetVerifyRoute } from "../../app/api/seller/password-reset/verify/route";
import { POST as cardRoute } from "../../app/api/seller/subscription/card/route";
import { POST as signupRoute } from "../../app/api/shop/[slug]/signup/route";
import { POST as confirmRoute } from "../../app/api/shop/[slug]/signup/verification/confirm/route";
import { POST as startRoute } from "../../app/api/shop/[slug]/signup/verification/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { IDV_INPUT, createSeller, db, resetDb } from "./helpers";

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
    const start = await startRoute(post(`${base}/verification`, IDV_INPUT), ctx(seller.slug));
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

describe("테스트 서버 모드: 운영 빌드에서 구독 결제 우회", () => {
  it("플래그가 없는 운영 빌드는 가짜 결제를 쓸 수 없고(결제 기록 없음), 플래그가 있으면 실제 결제 없이 카드 등록·결제가 성공하고 결제 번호에 fake가 붙는다", async () => {
    expect(seed({ OBS_TEST_MODE: "1", ...SEED }).code).toBe(0);
    await db.subscriptionPlan.create({ data: { code: "STANDARD", name: "월 구독", listPrice: 300000, salePrice: 199000 } });
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
    expect(payment).toMatchObject({ status: "PAID", amount: 199000 });
    expect(payment.providerPaymentId).toMatch(/^fake-pay-/);
  });
});
