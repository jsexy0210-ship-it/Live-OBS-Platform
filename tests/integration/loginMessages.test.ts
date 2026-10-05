import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as adminLogin } from "../../app/api/admin/auth/login/route";
import { POST as buyerLogin } from "../../app/api/shop/[slug]/auth/login/route";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createAdmin, createLoginBuyer, createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const buyer = (slug: string, body: unknown) =>
  buyerLogin(new Request(`http://localhost:3000/api/shop/${slug}/auth/login`, { method: "POST", headers: H, body: JSON.stringify(body) }), { params: Promise.resolve({ slug }) });
const admin = (body: unknown) => adminLogin(new Request("http://localhost:3000/api/admin/auth/login", { method: "POST", headers: H, body: JSON.stringify(body) }));

describe("구매자 로그인 실패 문구", () => {
  it("아이디가 없을 때와 비밀번호가 틀릴 때 같은 401·문구, 휴면·입력 누락·없는(운영 안 하는) 쇼핑몰은 사유별 문구", async () => {
    const { seller, grade } = await createSeller();
    const m = await createLoginBuyer(seller.id, grade.id);
    for (const body of [{ loginId: m.loginId, password: "wrong-password-1" }, { loginId: "nobody", password: PASSWORD }]) {
      const res = await buyer(seller.slug, body);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_credentials", message: "아이디나 비밀번호가 맞지 않아요" });
    }
    const empty = await buyer(seller.slug, { loginId: m.loginId });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "bad_request", message: "아이디와 비밀번호를 입력해 주세요" });

    await db.buyerMember.update({ where: { id: m.id }, data: { status: "DORMANT" } });
    const dormant = await buyer(seller.slug, { loginId: m.loginId, password: PASSWORD });
    expect(dormant.status).toBe(403);
    expect(await dormant.json()).toEqual({ error: "dormant", message: "오래 쓰지 않아 쉬고 있는 계정이에요. 쇼핑몰에 문의하면 다시 쓸 수 있어요" });


    await db.seller.update({ where: { id: seller.id }, data: { status: "SUSPENDED" } });
    for (const slug of [seller.slug, "no-such-shop"]) {
      const res = await buyer(slug, { loginId: m.loginId, password: PASSWORD });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_found", message: "지금은 쇼핑몰을 이용할 수 없어요" });
    }
  });
});

describe("마스터 로그인 실패 문구", () => {
  it("이메일이 없을 때와 비밀번호가 틀릴 때 같은 401·문구, 정지된 관리자·입력 누락은 사유별 문구", async () => {
    const a = await createAdmin("OPERATIONS");
    for (const body of [{ email: a.email, password: "wrong-password-1" }, { email: "nobody@example.com", password: PASSWORD }]) {
      const res = await admin(body);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_credentials", message: "이메일이나 비밀번호가 맞지 않습니다" });
    }
    const empty = await admin({ email: a.email });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "bad_request", message: "이메일과 비밀번호를 입력해 주십시오" });
    const suspended = await createAdmin("CS", { status: "SUSPENDED" });
    const res = await admin({ email: suspended.email, password: PASSWORD });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "account_disabled", message: "지금은 이 계정으로 로그인할 수 없습니다. 최고관리자에게 문의해 주십시오" });
    expect((await admin({ email: a.email, password: PASSWORD })).status).toBe(200);
  });
});
