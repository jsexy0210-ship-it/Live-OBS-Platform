import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as loginRoute } from "../../app/api/shop/[slug]/auth/login/route";
import { GET as consentGet, PUT as consentPut } from "../../app/api/shop/[slug]/me/marketing-consent/route";
import { POST as withdrawRoute } from "../../app/api/shop/[slug]/me/withdraw/route";
import { SIGNUP_CONSENT_VERSIONS } from "../../lib/server/buyers/consent";
import { setMarketingConsent } from "../../lib/server/buyers/marketingConsent";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createLoginBuyer, createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { "content-type": "application/json", host: "localhost:3000", origin: BASE };
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const V = SIGNUP_CONSENT_VERSIONS.marketing;

async function shop() {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  await db.buyerMember.update({ where: { id: buyer.id }, data: { marketingConsentAt: new Date("2026-10-01T00:00:00Z"), marketingConsentVersion: V } });
  const login = await loginRoute(
    new Request(`${BASE}/api/shop/${seller.slug}/auth/login`, { method: "POST", headers: H, body: JSON.stringify({ loginId: buyer.loginId, password: PASSWORD }) }),
    ctx(seller.slug),
  );
  const cookie = (login.headers.getSetCookie().find((c) => c.startsWith("lo_buyer=")) ?? "").split(";")[0];
  const get = (slug = seller.slug, c = cookie) => consentGet(new Request(`${BASE}/api/shop/${slug}/me/marketing-consent`, { headers: { ...H, ...(c ? { cookie: c } : {}) } }), ctx(slug));
  const put = (body: unknown, slug = seller.slug, c = cookie) =>
    consentPut(new Request(`${BASE}/api/shop/${slug}/me/marketing-consent`, { method: "PUT", headers: { ...H, ...(c ? { cookie: c } : {}) }, body: JSON.stringify(body) }), ctx(slug));
  return { seller, grade, buyer, cookie, get, put };
}

const audits = () => db.auditLog.findMany({ where: { action: { startsWith: "buyer.marketing_consent" } }, orderBy: { createdAt: "asc" }, select: { action: true } });

describe("구매자 마케팅 수신 동의 철회·다시 동의", () => {
  it("철회하면 동의 시각·버전이 비고 철회 시각이 남으며, 다시 보내도 바뀌지 않는다(감사 1건)", async () => {
    const s = await shop();
    expect(await (await s.get()).json()).toEqual({ agreed: true, agreedAt: "2026-10-01T00:00:00.000Z", version: V, withdrawnAt: null, currentVersion: V });
    const r = await s.put({ agreed: false });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ agreed: false, agreedAt: null, version: null });
    expect(body.withdrawnAt).not.toBeNull();
    const row = await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } });
    expect([row.marketingConsentAt, row.marketingConsentVersion]).toEqual([null, null]);
    expect(row.marketingWithdrawnAt).not.toBeNull();
    const again = await s.put({ agreed: false });
    expect(await again.json()).toEqual(body);
    expect(await audits()).toEqual([{ action: "buyer.marketing_consent.withdraw" }]);
  });

  it("다시 동의는 지금 문서 버전일 때만 받고(다르면 409, 값 불리언 아님 400), 동의하면 철회 시각을 비운다", async () => {
    const s = await shop();
    await s.put({ agreed: false });
    for (const [body, status] of [
      [{ agreed: true }, 409],
      [{ agreed: true, marketingVersion: "2020-01-01.v0" }, 409],
      [{ agreed: "true", marketingVersion: V }, 400],
      [{}, 400],
    ] as const) {
      expect((await s.put(body)).status).toBe(status);
    }
    expect((await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } })).marketingConsentAt).toBeNull();
    const r = await s.put({ agreed: true, marketingVersion: V });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ agreed: true, version: V, withdrawnAt: null });
    expect(await audits()).toEqual([{ action: "buyer.marketing_consent.withdraw" }, { action: "buyer.marketing_consent.agree" }]);
  });

  it("동의 중이지만 버전이 없거나 옛 버전이면 지금 버전으로 다시 동의할 때 버전·시각·감사가 새로 남고, 같은 버전으로 다시 보내면 바뀌지 않는다(Codex P1)", async () => {
    for (const old of [null, "2020-01-01.v0"]) {
      await resetDb();
      const s = await shop();
      const agreedAt = new Date("2026-09-01T00:00:00Z");
      await db.buyerMember.update({ where: { id: s.buyer.id }, data: { marketingConsentAt: agreedAt, marketingConsentVersion: old } });
      const r = await s.put({ agreed: true, marketingVersion: V });
      expect(r.status).toBe(200);
      const row = await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } });
      expect(row.marketingConsentVersion).toBe(V);
      expect(row.marketingConsentAt!.getTime()).toBeGreaterThan(agreedAt.getTime());
      expect(await audits()).toEqual([{ action: "buyer.marketing_consent.agree" }]);
      const again = await s.put({ agreed: true, marketingVersion: V });
      expect((await again.json()).agreedAt).toBe(row.marketingConsentAt!.toISOString());
      expect(await audits()).toHaveLength(1);
    }
  });

  it("로그인하지 않았거나 다른 쇼핑몰 세션이면 401이고 다른 회원의 동의는 바뀌지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    expect((await a.put({ agreed: false }, a.seller.slug, "")).status).toBe(401);
    expect((await a.get(a.seller.slug, "")).status).toBe(401);
    expect((await a.put({ agreed: false }, b.seller.slug)).status).toBe(401);
    expect((await db.buyerMember.findUniqueOrThrow({ where: { id: b.buyer.id } })).marketingConsentAt).not.toBeNull();
    expect((await db.buyerMember.findUniqueOrThrow({ where: { id: a.buyer.id } })).marketingConsentAt).not.toBeNull();
  });

  it("동시에 철회해도 기록은 한 번만 바뀐다", async () => {
    const s = await shop();
    const rs = await Promise.all([1, 2, 3].map(() => setMarketingConsent(db, { sellerId: s.seller.id, buyerMemberId: s.buyer.id }, { agreed: false })));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(rs.filter((r) => r.ok && r.changed).length).toBe(1);
    expect(await audits()).toHaveLength(1);
  });

  it("회원 탈퇴하면 마케팅 동의 시각·버전·철회 시각을 모두 비운다", async () => {
    const s = await shop();
    await s.put({ agreed: false });
    const w = await withdrawRoute(
      new Request(`${BASE}/api/shop/${s.seller.slug}/me/withdraw`, { method: "POST", headers: { ...H, cookie: s.cookie }, body: JSON.stringify({ password: PASSWORD }) }),
      ctx(s.seller.slug),
    );
    expect(w.status).toBe(200);
    const row = await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } });
    expect([row.marketingConsentAt, row.marketingConsentVersion, row.marketingWithdrawnAt]).toEqual([null, null, null]);
  });
});
