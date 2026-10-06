import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as prefsGet, PUT as prefsPut } from "../../app/api/shop/[slug]/me/notification-prefs/route";
import { SIGNUP_CONSENT_VERSIONS } from "../../lib/server/buyers/consent";
import { notifyEnabled } from "../../lib/server/buyers/notificationPrefs";
import { loginBuyer } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createLoginBuyer, createSeller, db, resetDb } from "./helpers";

// SH-025 알림 설정: 종류 × 채널 표, 필수 종류 고정, 혜택·이벤트 = 마케팅 수신 동의, 광고성은 메일만.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { "content-type": "application/json", host: "localhost:3000", origin: BASE };
const ctx = (slug: string) => ({ params: Promise.resolve({ slug }) });
const V = SIGNUP_CONSENT_VERSIONS.marketing;

async function shop(consent = true) {
  const { seller, grade } = await createSeller();
  const buyer = await createLoginBuyer(seller.id, grade.id);
  if (consent) await db.buyerMember.update({ where: { id: buyer.id }, data: { marketingConsentAt: new Date("2026-10-01T00:00:00Z"), marketingConsentVersion: V } });
  const r = await loginBuyer(db, { sellerId: seller.id, loginId: buyer.loginId!, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  const cookie = `lo_buyer=${r.token}`;
  const get = () => prefsGet(new Request(`${BASE}/api/shop/${seller.slug}/me/notification-prefs`, { headers: { ...H, cookie } }), ctx(seller.slug));
  const put = (body: unknown, c = cookie) => prefsPut(new Request(`${BASE}/api/shop/${seller.slug}/me/notification-prefs`, { method: "PUT", headers: { ...H, ...(c ? { cookie: c } : {}) }, body: JSON.stringify(body) }), ctx(seller.slug));
  const scope = { sellerId: seller.id, buyerMemberId: buyer.id };
  return { seller, buyer, get, put, scope };
}
type Items = { items: { kind: string; required: boolean; ad: boolean; message: boolean | null; email: boolean | null }[] };
const row = (j: Items, kind: string) => j.items.find((i) => i.kind === kind)!;

describe("구매자 알림 설정 조회·저장", () => {
  it("로그인 없이는 401, 기본값: 필수·배송은 켬, 광고성은 알림톡·문자 칸 없음(null)이고 동의 중이면 이메일 켬", async () => {
    const s = await shop();
    expect((await s.put({ prefs: {} }, "")).status).toBe(401);
    const j = (await (await s.get()).json()) as Items;
    expect(j.items.map((i) => i.kind)).toEqual(["ORDER", "QUEUE", "SHIPPING", "BROADCAST_START", "DISCOUNT_RESTOCK", "BENEFIT"]);
    expect(row(j, "ORDER")).toMatchObject({ required: true, ad: false, message: true, email: true });
    expect(row(j, "SHIPPING")).toMatchObject({ required: false, message: true, email: true });
    for (const k of ["BROADCAST_START", "DISCOUNT_RESTOCK", "BENEFIT"]) expect(row(j, k)).toMatchObject({ ad: true, message: null, email: true });
  });

  it("필수 종류를 끄면 400 required_notification, 광고성 알림톡·문자 칸·모르는 종류·잘못된 모양은 400, 아무것도 저장되지 않는다", async () => {
    const s = await shop();
    for (const [body, error] of [
      [{ prefs: { ORDER: { email: false } } }, "required_notification"],
      [{ prefs: { QUEUE: { message: false } } }, "required_notification"],
      [{ prefs: { BROADCAST_START: { message: true } } }, "invalid_notification_prefs"],
      [{ prefs: { BENEFIT: { message: false } } }, "invalid_notification_prefs"],
      [{ prefs: { NOPE: { email: true } } }, "invalid_notification_prefs"],
      [{ prefs: { SHIPPING: { email: "no" } } }, "invalid_notification_prefs"],
      [{ prefs: { SHIPPING: { sms: true } } }, "invalid_notification_prefs"],
      [{}, "invalid_notification_prefs"],
    ] as const) {
      const r = await s.put(body);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect((await r.json()).error).toBe(error);
    }
    expect(await db.buyerNotificationPref.count()).toBe(0);
    // 필수 종류를 켬(true)으로 보내는 건 그대로 통과
    expect((await s.put({ prefs: { ORDER: { email: true, message: true } } })).status).toBe(200);
  });

  it("배송 채널을 끄고 켠다(보낸 칸만 바뀜), 응답은 저장 뒤 조회와 같다", async () => {
    const s = await shop();
    const r = await s.put({ prefs: { SHIPPING: { message: false } } });
    expect(r.status).toBe(200);
    const j = (await r.json()) as Items;
    expect(row(j, "SHIPPING")).toMatchObject({ message: false, email: true });
    expect(await (await s.get()).json()).toEqual(j);
    expect(await notifyEnabled(db, s.scope, "SHIPPING", "MESSAGE")).toBe(false);
    expect(await notifyEnabled(db, s.scope, "SHIPPING", "EMAIL")).toBe(true);
    const back = (await (await s.put({ prefs: { SHIPPING: { message: true, email: false } } })).json()) as Items;
    expect(row(back, "SHIPPING")).toMatchObject({ message: true, email: false });
    expect(await db.buyerNotificationPref.count()).toBe(2);
  });
});

describe("혜택·이벤트 = 마케팅 수신 동의", () => {
  it("혜택·이벤트를 끄면 동의가 철회되고(감사 1건) 광고성 줄이 모두 꺼진 것으로 보이며 발송 확인도 false", async () => {
    const s = await shop();
    const j = (await (await s.put({ prefs: { BENEFIT: { email: false } } })).json()) as Items & { marketing: { agreed: boolean; withdrawnAt: string | null } };
    expect(j.marketing.agreed).toBe(false);
    expect(j.marketing.withdrawnAt).not.toBeNull();
    for (const k of ["BROADCAST_START", "DISCOUNT_RESTOCK", "BENEFIT"]) expect(row(j, k).email).toBe(false);
    const m = await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } });
    expect(m.marketingConsentAt).toBeNull();
    expect(await db.auditLog.count({ where: { action: "buyer.marketing_consent.withdraw" } })).toBe(1);
    for (const k of ["BROADCAST_START", "DISCOUNT_RESTOCK", "BENEFIT"] as const) expect(await notifyEnabled(db, s.scope, k, "EMAIL")).toBe(false);
    expect(await notifyEnabled(db, s.scope, "ORDER", "MESSAGE")).toBe(true);
  });

  it("동의 없이 방송 시작·할인 이메일을 켜면 409, 혜택을 같이 켜면(문서 버전 필수) 동의가 기록되고 통과", async () => {
    const s = await shop(false);
    const j0 = (await (await s.get()).json()) as Items;
    for (const k of ["BROADCAST_START", "DISCOUNT_RESTOCK", "BENEFIT"]) expect(row(j0, k).email).toBe(false);
    const r = await s.put({ prefs: { BROADCAST_START: { email: true } } });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("marketing_consent_required");
    const old = await s.put({ prefs: { BENEFIT: { email: true } } });
    expect(old.status).toBe(409);
    expect((await old.json()).error).toBe("consent_outdated");
    const ok = await s.put({ prefs: { BENEFIT: { email: true }, BROADCAST_START: { email: true } }, marketingVersion: V });
    expect(ok.status).toBe(200);
    const j = (await ok.json()) as Items;
    expect(row(j, "BENEFIT").email).toBe(true);
    expect(row(j, "BROADCAST_START").email).toBe(true);
    expect(await notifyEnabled(db, s.scope, "BROADCAST_START", "EMAIL")).toBe(true);
    expect(await notifyEnabled(db, s.scope, "BROADCAST_START", "MESSAGE")).toBe(false); // 광고성 알림톡·문자 금지
  });

  it("혜택을 끄면서 방송 시작을 켜는 요청은 409이고 동의 상태는 바뀌지 않는다", async () => {
    const s = await shop();
    const r = await s.put({ prefs: { BENEFIT: { email: false }, BROADCAST_START: { email: true } } });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe("marketing_consent_required");
    const m = await db.buyerMember.findUniqueOrThrow({ where: { id: s.buyer.id } });
    expect(m.marketingConsentAt).not.toBeNull();
    expect(await db.auditLog.count({ where: { action: { startsWith: "buyer.marketing_consent" } } })).toBe(0);
  });

  it("방송 시작만 끄면 동의는 유지되고 그 칸만 꺼진다(다른 광고성 줄은 그대로)", async () => {
    const s = await shop();
    const j = (await (await s.put({ prefs: { BROADCAST_START: { email: false } } })).json()) as Items & { marketing: { agreed: boolean } };
    expect(j.marketing.agreed).toBe(true);
    expect(row(j, "BROADCAST_START").email).toBe(false);
    expect(row(j, "DISCOUNT_RESTOCK").email).toBe(true);
    expect(await notifyEnabled(db, s.scope, "DISCOUNT_RESTOCK", "EMAIL")).toBe(true);
    expect(await notifyEnabled(db, s.scope, "BROADCAST_START", "EMAIL")).toBe(false);
  });
});
