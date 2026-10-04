import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POST as resetConfirmRoute } from "../../app/api/seller/password-reset/confirm/route";
import { POST as resetResendRoute } from "../../app/api/seller/password-reset/resend/route";
import { POST as resetStartRoute } from "../../app/api/seller/password-reset/start/route";
import { POST as signupConfirmRoute } from "../../app/api/seller-signup/verification/confirm/route";
import { POST as signupResendRoute } from "../../app/api/seller-signup/verification/resend/route";
import { POST as signupStartRoute } from "../../app/api/seller-signup/verification/route";
import { prisma } from "../../lib/server/db";
import { IDV_INPUT, SELLER_SIGNUP_CONSENT, createSeller, db, resetDb } from "./helpers";

// Next는 동적 세그먼트가 없는 라우트(/api/seller-signup/…, /api/seller/password-reset/…)에도 두 번째 인자를 넘기고,
// 그 params는 undefined로 풀린다. 인증번호 다시 받기·확인 라우트가 이때 500이 나지 않아야 한다(화면 e2e에서 발견).
beforeAll(() => {
  process.env.IDENTITY_HASH_KEY = "test-identity-hash-key-0123456789abcdef";
});
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const post = (path: string, body: unknown, cookie?: string) =>
  new Request(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json", host: "localhost:3000", origin: BASE, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
// Next 실행 환경이 정적 라우트에 넘기는 모양
const nextCtx = () => ({ params: Promise.resolve(undefined) as unknown as Promise<{ slug?: string }> });

async function started(res: Response) {
  expect(res.status).toBe(200);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  const { verificationId } = (await res.json()) as { verificationId: string };
  return { cookie, verificationId };
}

describe("정적 라우트의 인증번호 다시 받기·확인(Next가 넘기는 params가 undefined)", () => {
  it("파트너스 가입: 다시 받기는 500이 아니고, 확인은 200이다", async () => {
    const { cookie, verificationId } = await started(await signupStartRoute(post("/api/seller-signup/verification", { ...IDV_INPUT, ...SELLER_SIGNUP_CONSENT })));
    const resend = await signupResendRoute(post("/api/seller-signup/verification/resend", { verificationId }, cookie), nextCtx());
    expect(resend.status).not.toBe(500);
    const confirm = await signupConfirmRoute(post("/api/seller-signup/verification/confirm", { verificationId, code: "000000" }, cookie), nextCtx());
    expect(confirm.status).toBe(200);
  });

  it("비밀번호 찾기: 다시 받기는 500이 아니고, 확인은 200이다", async () => {
    const { seller } = await createSeller();
    const { cookie, verificationId } = await started(
      await resetStartRoute(post("/api/seller/password-reset/start", { email: "owner@example.com", shopSlug: seller.slug, person: IDV_INPUT })),
    );
    const resend = await resetResendRoute(post("/api/seller/password-reset/resend", { verificationId }, cookie), nextCtx());
    expect(resend.status).not.toBe(500);
    const confirm = await resetConfirmRoute(post("/api/seller/password-reset/confirm", { verificationId, code: "000000" }, cookie), nextCtx());
    expect(confirm.status).toBe(200);
  });
});
