import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as callbackRoute } from "../../app/api/seller/external-shops/oauth-done/route";
import { GET as listRoute, POST as startRoute } from "../../app/api/seller/external-shops/route";
import { DELETE as deleteRoute } from "../../app/api/seller/external-shops/[id]/route";
import { POST as webhookRoute } from "../../app/api/external/webhook/route";
import { loginSeller } from "../../lib/server/auth/login";
import { openBillingKey } from "../../lib/server/billing/secret";
import { completeConnect, disconnect, listConnections, startConnect, startReconnect } from "../../lib/server/external/connect";
import { externalConfig } from "../../lib/server/external/config";
import { purgeExpiredOAuthStates, purgeOldWebhookEvents, refreshDueTokens } from "../../lib/server/external/jobs";
import { SCHEDULED_JOBS } from "../../lib/server/jobs/scheduler";
import { ExternalHttpError, shopKeyOf, type ExternalShopProvider, type TokenSet } from "../../lib/server/external/provider";
import { ingestWebhook } from "../../lib/server/external/webhook";
import { prisma } from "../../lib/server/db";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

const afterCalls: (() => unknown)[] = [];
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), after: (fn: () => unknown) => void afterCalls.push(fn) }));

// 외부 쇼핑몰 연동 기반(SA-006 서버): 연결 시작·콜백(1회용 state·세션 묶음)·토큰 암호화·해제·웹훅 인증키·중복·격리.
// 공급자는 가짜(실제 외부 호출 없음). 설정 키는 시험용 임의값.
const ENV = { EXTERNAL_SHOP_CLIENT_ID: "test-client", EXTERNAL_SHOP_CLIENT_SECRET: "test-secret-0123456789", EXTERNAL_SHOP_REDIRECT_URI: "https://example.test/cb", EXTERNAL_WEBHOOK_API_KEY: "test-webhook-key-0123456789" };
const cfg = externalConfig(ENV);

class FakeProvider implements ExternalShopProvider {
  exchanged: string[] = [];
  revokes: string[] = [];
  failExchange = false;
  revokeResult: "ok" | "retry" = "ok";
  authorizeUrl(shopKey: string, state: string) {
    return `https://${shopKey}.auth.test/authorize?state=${state}`;
  }
  async exchangeCode(shopKey: string, code: string): Promise<TokenSet> {
    if (this.failExchange) throw new Error("boom");
    this.exchanged.push(`${shopKey}:${code}`);
    return { accessToken: `AT-${code}`, refreshToken: `RT-${code}`, accessExpiresAt: new Date(Date.now() + 7200_000), refreshExpiresAt: new Date(Date.now() + 14 * 86400_000), scopes: "mall.read_order" };
  }
  refreshes: string[] = [];
  refreshError: Error | null = null;
  async refresh(shopKey: string, refreshToken: string): Promise<TokenSet> {
    if (this.refreshError) throw this.refreshError;
    this.refreshes.push(`${shopKey}:${refreshToken}`);
    return { accessToken: `AT2-${refreshToken}`, refreshToken: `RT2-${refreshToken}`, accessExpiresAt: new Date(Date.now() + 7200_000), refreshExpiresAt: new Date(Date.now() + 14 * 86400_000), scopes: null };
  }
  async revoke(shopKey: string) {
    this.revokes.push(shopKey);
    return this.revokeResult;
  }
}

beforeAll(() => {
  process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef";
});
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

async function shop(permissions: string[] = [], owner = true) {
  const { seller } = await createSeller();
  const user = owner ? await createSellerUser(seller.id, "OWNER") : await createSellerUser(seller.id, { permissions: permissions as never });
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: user.id, isOwner: owner, permissions: owner ? [] : (permissions as never), readOnly: false };
  return { seller, user, ctx };
}
const stateOf = (url: string) => new URL(url).searchParams.get("state")!;

describe("연결 시작·콜백", () => {
  it("연결 시작 → 콜백 성공: 토큰은 암호화되어 저장되고 원문은 어디에도 없다", async () => {
    const s = await shop();
    const p = new FakeProvider();
    const start = await startConnect(db, p, s.ctx, "https://myshop.cafe24.com");
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    const r = await completeConnect(db, p, s.ctx, { state: stateOf(start.authorizeUrl), code: "abc" });
    expect(r.ok).toBe(true);
    const c = await db.externalShopConnection.findFirstOrThrow();
    expect(c).toMatchObject({ sellerId: s.seller.id, shopKey: "myshop", status: "CONNECTED" });
    expect(c.accessTokenCipher).not.toContain("AT-abc");
    expect(openBillingKey(c.refreshTokenCipher!, s.seller.id)).toBe("RT-abc");
    // 다른 판매자 id로는 풀리지 않는다
    expect(() => openBillingKey(c.refreshTokenCipher!, "00000000-0000-4000-8000-000000000000")).toThrow();
    expect(JSON.stringify(await db.auditLog.findMany())).not.toMatch(/AT-abc|RT-abc/);
  });

  it("지원하지 않는 주소(내부 주소·IP·http·사용자 정의 도메인)는 시작하지 않는다", async () => {
    const s = await shop();
    for (const u of ["http://myshop.cafe24.com", "https://127.0.0.1", "https://localhost", "https://169.254.169.254", "https://evil.example.com", "https://myshop.cafe24.com:8443", "https://user:pw@myshop.cafe24.com", "https://x.cafe24.com.evil.com", 42, null])
      expect(await startConnect(db, new FakeProvider(), s.ctx, u)).toEqual({ ok: false, reason: "shop_not_supported" });
    expect(shopKeyOf("https://MyShop.Cafe24.com/path?x=1")).toBe("myshop");
    expect(await db.externalOAuthState.count()).toBe(0);
  });

  it("state 검증: 없는·모르는·이미 쓴·만료된·다른 파트너스·다른 직원의 state는 모두 거절되고 연결이 생기지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const p = new FakeProvider();
    const start = await startConnect(db, p, a.ctx, "https://shopa.cafe24.com");
    if (!start.ok) throw new Error("start");
    const st = stateOf(start.authorizeUrl);
    expect(await completeConnect(db, p, a.ctx, { state: null, code: "x" })).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(await completeConnect(db, p, a.ctx, { state: "nope", code: "x" })).toMatchObject({ ok: false, reason: "invalid_state" });
    // 다른 파트너스의 세션으로는 쓸 수 없고, 쓰려다 실패해도 원래 state는 태워지지 않는다
    expect(await completeConnect(db, p, b.ctx, { state: st, code: "x" })).toMatchObject({ ok: false, reason: "invalid_state" });
    const staff = await shop();
    const sameSellerOtherUser: TenantContext = { ...a.ctx, actorId: staff.user.id };
    expect(await completeConnect(db, p, sameSellerOtherUser, { state: st, code: "x" })).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(await db.externalShopConnection.count()).toBe(0);
    expect(p.exchanged).toEqual([]);
    // 만료
    await db.externalOAuthState.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await completeConnect(db, p, a.ctx, { state: st, code: "x" })).toMatchObject({ ok: false, reason: "invalid_state" });
    await db.externalOAuthState.updateMany({ data: { expiresAt: new Date(Date.now() + 600_000) } });
    // 맞는 호출은 한 번만
    expect((await completeConnect(db, p, a.ctx, { state: st, code: "good" })).ok).toBe(true);
    expect(await completeConnect(db, p, a.ctx, { state: st, code: "again" })).toMatchObject({ ok: false, reason: "invalid_state" });
    expect(p.exchanged).toEqual(["shopa:good"]);
  });

  it("토큰 교환이 실패하면 연결이 생기지 않고 state는 다시 쓸 수 없다", async () => {
    const s = await shop();
    const p = new FakeProvider();
    const start = await startConnect(db, p, s.ctx, "https://myshop.cafe24.com");
    if (!start.ok) throw new Error("start");
    p.failExchange = true;
    expect(await completeConnect(db, p, s.ctx, { state: stateOf(start.authorizeUrl), code: "c" })).toEqual({ ok: false, reason: "exchange_failed" });
    expect(await db.externalShopConnection.count()).toBe(0);
    p.failExchange = false;
    expect(await completeConnect(db, p, s.ctx, { state: stateOf(start.authorizeUrl), code: "c" })).toMatchObject({ reason: "invalid_state" });
  });

  it("같은 쇼핑몰은 두 파트너스에 동시에 붙지 않는다", async () => {
    const a = await shop();
    const b = await shop();
    const p = new FakeProvider();
    const sa = await startConnect(db, p, a.ctx, "https://shared.cafe24.com");
    const sb = await startConnect(db, p, b.ctx, "https://shared.cafe24.com");
    if (!sa.ok || !sb.ok) throw new Error("start");
    expect((await completeConnect(db, p, a.ctx, { state: stateOf(sa.authorizeUrl), code: "1" })).ok).toBe(true);
    expect(await completeConnect(db, p, b.ctx, { state: stateOf(sb.authorizeUrl), code: "2" })).toEqual({ ok: false, reason: "already_connected" });
    expect(await startConnect(db, p, b.ctx, "https://shared.cafe24.com")).toEqual({ ok: false, reason: "already_connected" });
    expect(await db.externalShopConnection.count()).toBe(1);
  });

  it("권한: 쇼핑몰 설정 권한이 없는 직원은 시작·콜백·해제 모두 403, 연동 키가 없으면 시작은 integration_disabled", async () => {
    const owner = await shop();
    const none = await shop([], false);
    const p = new FakeProvider();
    await expect(startConnect(db, p, none.ctx, "https://myshop.cafe24.com")).rejects.toMatchObject({ status: 403 });
    await expect(completeConnect(db, p, none.ctx, { state: "x", code: "y" })).rejects.toMatchObject({ status: 403 });
    expect(await startConnect(db, null, owner.ctx, "https://myshop.cafe24.com")).toEqual({ ok: false, reason: "integration_disabled" });
    const withPerm = await shop(["SHOP_SETTINGS"], false);
    expect((await startConnect(db, p, withPerm.ctx, "https://perm.cafe24.com")).ok).toBe(true);
  });
});

describe("해제", () => {
  async function connected(p = new FakeProvider()) {
    const s = await shop();
    const st = await startConnect(db, p, s.ctx, "https://myshop.cafe24.com");
    if (!st.ok) throw new Error("start");
    const r = await completeConnect(db, p, s.ctx, { state: stateOf(st.authorizeUrl), code: "k" });
    if (!r.ok) throw new Error("complete");
    return { ...s, p, id: r.connectionId };
  }
  it("철회 성공: 토큰을 지우고 해제됨, 이후 웹훅은 받지 않는다", async () => {
    const s = await connected();
    expect(await disconnect(db, s.p, s.ctx, s.id)).toEqual({ ok: true, status: "DISCONNECTED" });
    expect(s.p.revokes).toEqual(["myshop"]);
    expect(await db.externalShopConnection.findUniqueOrThrow({ where: { id: s.id } })).toMatchObject({ status: "DISCONNECTED", accessTokenCipher: null, refreshTokenCipher: null });
    const body = JSON.stringify({ resource: { mall_id: "myshop" }, event_no: 1 });
    expect(await ingestWebhook(db, cfg, { rawBody: body, apiKey: cfg.webhookKey })).toEqual({ status: 200, stored: false, ignored: "unknown_shop" });
    expect(await db.externalWebhookEvent.count()).toBe(0);
    // 다시 해제해도 같다
    expect(await disconnect(db, s.p, s.ctx, s.id)).toEqual({ ok: true, status: "DISCONNECTED" });
  });
  it("철회가 실패하면 해제 대기: 철회용 토큰 사본만 남고 주문 수신은 멈춘다", async () => {
    const s = await connected();
    s.p.revokeResult = "retry";
    expect(await disconnect(db, s.p, s.ctx, s.id)).toEqual({ ok: true, status: "DISCONNECT_PENDING" });
    const c = await db.externalShopConnection.findUniqueOrThrow({ where: { id: s.id } });
    expect(c.accessTokenCipher).toBeNull();
    expect(openBillingKey(c.refreshTokenCipher!, s.seller.id)).toBe("RT-k");
    const body = JSON.stringify({ resource: { mall_id: "myshop" }, event_no: 2 });
    expect(await ingestWebhook(db, cfg, { rawBody: body, apiKey: cfg.webhookKey })).toEqual({ status: 200, stored: false, ignored: "unknown_shop" });
    expect(await db.externalWebhookEvent.count()).toBe(0);
  });
  it("다른 파트너스의 연결은 해제할 수 없다(404)", async () => {
    const s = await connected();
    const other = await shop();
    await expect(disconnect(db, s.p, other.ctx, s.id)).rejects.toMatchObject({ status: 404 });
    expect((await db.externalShopConnection.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("CONNECTED");
  });
});

describe("웹훅 수신", () => {
  async function connected() {
    const s = await shop();
    const p = new FakeProvider();
    const st = await startConnect(db, p, s.ctx, "https://myshop.cafe24.com");
    if (!st.ok) throw new Error("start");
    await completeConnect(db, p, s.ctx, { state: stateOf(st.authorizeUrl), code: "k" });
    return s;
  }
  const send = (body: string, key: string | null) => ingestWebhook(db, cfg, { rawBody: body, apiKey: key });
  const KEY = cfg.webhookKey;
  const evt = (n: number) => JSON.stringify({ resource: { mall_id: "myshop", order_id: `o-${n}` }, event_no: 90023 });

  it("인증키가 없거나 틀리면 401이고 아무것도 저장되지 않는다. 맞으면 저장, 같은 본문 재전송은 한 번만", async () => {
    await connected();
    const body = evt(1);
    expect((await send(body, null)).status).toBe(401);
    expect((await send(body, "AAAA")).status).toBe(401);
    expect((await send(body, cfg.clientSecret)).status).toBe(401);
    expect(await db.externalWebhookEvent.count()).toBe(0);
    expect(await send(body, KEY)).toEqual({ status: 200, stored: true });
    expect(await send(body, KEY)).toEqual({ status: 200, stored: false });
    expect(await send(evt(2), KEY)).toEqual({ status: 200, stored: true });
    expect(await db.externalWebhookEvent.count()).toBe(2);
    expect((await db.externalShopConnection.findFirstOrThrow()).lastEventAt).not.toBeNull();
  });
  it("모르는 몰·잘못된 본문·너무 큰 본문은 저장하지 않는다", async () => {
    await connected();
    const body = evt(3);
    expect((await send(body, null)).status).toBe(401);
    const unknown = JSON.stringify({ resource: { mall_id: "nobody" } });
    expect(await send(unknown, KEY)).toEqual({ status: 200, stored: false, ignored: "unknown_shop" }); // 인증 통과 + 연결 안 된 몰 = 200, 저장 안 함
    expect((await send("not json", KEY)).status).toBe(400);
    const noMall = JSON.stringify({ resource: {} });
    expect((await send(noMall, KEY)).status).toBe(400);
    const big = JSON.stringify({ resource: { mall_id: "myshop" }, pad: "x".repeat(300_000) });
    expect((await send(big, KEY)).status).toBe(413);
    expect(await db.externalWebhookEvent.count()).toBe(0);
  });
  it("연동 키가 없으면 503, 결제 유예가 끝나 잠긴 파트너스는 저장하지 않는다", async () => {
    const s = await connected();
    const body = evt(4);
    expect((await ingestWebhook(db, externalConfig({}), { rawBody: body, apiKey: KEY })).status).toBe(503);
    // 인증키만 없어도 웹훅은 받지 않는다(빈 키로 통과하지 않음)
    const noKey = externalConfig({ ...ENV, EXTERNAL_WEBHOOK_API_KEY: "" });
    expect((await ingestWebhook(db, noKey, { rawBody: body, apiKey: "" })).status).toBe(503);
    await db.seller.update({ where: { id: s.seller.id }, data: { trialEndsAt: new Date(Date.now() - 86400_000) } });
    expect(await send(body, KEY)).toEqual({ status: 200, stored: false });
    expect(await db.externalWebhookEvent.count()).toBe(0);
  });
});

describe("라우트", () => {
  const cookieFor = async (email: string) => {
    const r = await loginSeller(db, { email, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    return `lo_seller=${r.token}`;
  };
  const H = (cookie: string) => ({ host: "localhost:3000", origin: "http://localhost:3000", cookie, "content-type": "application/json" });

  it("로그인 없이는 목록·시작·콜백이 거절되고, 키가 없으면 목록은 enabled:false · 시작은 503(플랫폼 이름 없음)", async () => {
    const s = await shop();
    delete process.env.EXTERNAL_SHOP_CLIENT_ID;
    expect((await listRoute(new Request("http://localhost:3000/api/seller/external-shops", { headers: { host: "localhost:3000" } }))).status).toBe(401);
    const cookie = await cookieFor(s.user.email);
    const list = await listRoute(new Request("http://localhost:3000/api/seller/external-shops", { headers: H(cookie) }));
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual({ enabled: false, canManage: true, connections: [] });
    const start = await startRoute(new Request("http://localhost:3000/api/seller/external-shops", { method: "POST", headers: H(cookie), body: JSON.stringify({ shopUrl: "https://myshop.cafe24.com" }) }));
    expect(start.status).toBe(503);
    expect(JSON.stringify(await start.json())).not.toMatch(/cafe24/i);
    const cb = await callbackRoute(new Request("http://localhost:3000/api/seller/external-shops/oauth-done?state=x&code=y", { headers: { host: "localhost:3000", cookie } }));
    expect(cb.status).toBe(303);
    expect(cb.headers.get("location")).toBe("/seller/external-shops?error=integration_disabled");
    const noLogin = await callbackRoute(new Request("http://localhost:3000/api/seller/external-shops/oauth-done?state=x&code=y", { headers: { host: "localhost:3000" } }));
    expect(noLogin.headers.get("location")).toBe("/seller/external-shops?error=login_required");
    const del = await deleteRoute(new Request("http://localhost:3000/api/seller/external-shops/zzz", { method: "DELETE", headers: H(cookie) }), { params: Promise.resolve({ id: "zzz" }) });
    expect(del.status).toBe(404);
  });
  it("웹훅 라우트: 키가 없으면 503, 응답 본문은 비어 있다", async () => {
    delete process.env.EXTERNAL_SHOP_CLIENT_ID;
    const res = await webhookRoute(new Request("http://localhost:3000/api/external/webhook", { method: "POST", body: "{}" }));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("");
  });
  it("웹훅 라우트: 선언한 본문 크기가 상한을 넘으면 읽기 전에 413", async () => {
    const res = await webhookRoute(new Request("http://localhost:3000/api/external/webhook", { method: "POST", headers: { "content-length": String(300 * 1024) }, body: "{}" }));
    expect(res.status).toBe(413);
  });
});

describe("정기 작업", () => {
  const DAY = 86_400_000;
  async function connected(key = "myshop") {
    const s = await shop();
    const p = new FakeProvider();
    const st = await startConnect(db, p, s.ctx, `https://${key}.cafe24.com`);
    if (!st.ok) throw new Error("start");
    const r = await completeConnect(db, p, s.ctx, { state: stateOf(st.authorizeUrl), code: "k" });
    if (!r.ok) throw new Error("complete");
    return { ...s, p, id: r.connectionId };
  }
  const conn = (id: string) => db.externalShopConnection.findUniqueOrThrow({ where: { id } });

  it("스케줄러에 세 작업이 등록되어 있다", () => {
    const names = SCHEDULED_JOBS.map((j) => j.name);
    for (const n of ["external_oauth_state.purge", "external_webhook_event.purge_old", "external_shop.refresh_tokens"]) expect(names).toContain(n);
  });

  it("끝난 OAuth state는 만료 1일 뒤 지우고, 방금 만든 것·만료 직후 것은 남긴다", async () => {
    const s = await shop();
    const mk = (h: string, exp: number) => db.externalOAuthState.create({ data: { sellerId: s.seller.id, userId: s.user.id, shopKey: "a-shop", stateHash: h, expiresAt: new Date(Date.now() + exp) } });
    await mk("old", -2 * DAY);
    await mk("recent-expired", -3600_000);
    await mk("live", 600_000);
    expect(await db.$transaction((tx) => purgeExpiredOAuthStates(tx, new Date()))).toBe(1);
    expect((await db.externalOAuthState.findMany({ select: { stateHash: true } })).map((r) => r.stateHash).sort()).toEqual(["live", "recent-expired"]);
    expect(await db.$transaction((tx) => purgeExpiredOAuthStates(tx, new Date()))).toBe(0);
  });

  it("웹훅 원본은 받은 지 30일이 지나면 처리 여부와 관계없이 지운다", async () => {
    const c = await connected();
    const mk = (k: string, ageDays: number, processed: boolean) =>
      db.externalWebhookEvent.create({ data: { sellerId: c.seller.id, connectionId: c.id, eventKey: k, payload: { k }, receivedAt: new Date(Date.now() - ageDays * DAY), processedAt: processed ? new Date() : null } });
    await mk("old-unprocessed", 31, false);
    await mk("old-processed", 40, true);
    await mk("fresh", 29, false);
    expect(await db.$transaction((tx) => purgeOldWebhookEvents(tx, new Date()))).toBe(2);
    expect((await db.externalWebhookEvent.findMany({ select: { eventKey: true } })).map((e) => e.eventKey)).toEqual(["fresh"]);
  });

  it("토큰 갱신: 곧 만료되는 것만 새 토큰(접근·갱신 둘 다)으로 바꾼다", async () => {
    const due = await connected("dueshop");
    const fine = await connected("fineshop");
    await db.externalShopConnection.update({ where: { id: due.id }, data: { refreshExpiresAt: new Date(Date.now() + DAY) } });
    expect(await refreshDueTokens(db, due.p, new Date())).toBe(1);
    const c = await conn(due.id);
    expect(openBillingKey(c.refreshTokenCipher!, due.seller.id)).toBe("RT2-RT-k");
    expect(openBillingKey(c.accessTokenCipher!, due.seller.id)).toBe("AT2-RT-k");
    expect(c.refreshExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 10 * DAY);
    expect(due.p.refreshes).toEqual(["dueshop:RT-k"]);
    expect((await conn(fine.id)).status).toBe("CONNECTED");
    expect(openBillingKey((await conn(fine.id)).refreshTokenCipher!, fine.seller.id)).toBe("RT-k");
    // 다시 돌려도 더 바꾸지 않는다
    expect(await refreshDueTokens(db, due.p, new Date())).toBe(0);
  });

  it("갱신이 400·401이면 다시 연결 필요(토큰 삭제), 5xx·네트워크 오류는 그대로 두고 다음에 다시, 갱신 토큰이 이미 만료면 부르지 않고 다시 연결 필요", async () => {
    const a = await connected("shopa");
    await db.externalShopConnection.update({ where: { id: a.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    a.p.refreshError = new ExternalHttpError(401);
    expect(await refreshDueTokens(db, a.p, new Date())).toBe(1);
    expect(await conn(a.id)).toMatchObject({ status: "REAUTH_REQUIRED", accessTokenCipher: null, refreshTokenCipher: null });

    const b = await connected("shopb");
    await db.externalShopConnection.update({ where: { id: b.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    b.p.refreshError = new ExternalHttpError(503);
    expect(await refreshDueTokens(db, b.p, new Date())).toBe(0);
    b.p.refreshError = new Error("timeout");
    expect(await refreshDueTokens(db, b.p, new Date())).toBe(0);
    expect(await conn(b.id)).toMatchObject({ status: "CONNECTED" });
    expect((await conn(b.id)).refreshTokenCipher).not.toBeNull();

    // 앞서 시험한 연결은 대상에서 뺀다(이번 확인은 갱신 토큰이 이미 만료된 연결만)
    await db.externalShopConnection.update({ where: { id: b.id }, data: { accessExpiresAt: new Date(Date.now() + 7200_000) } });
    const c = await connected("shopc");
    await db.externalShopConnection.update({ where: { id: c.id }, data: { refreshExpiresAt: new Date(Date.now() - 1000) } });
    expect(await refreshDueTokens(db, c.p, new Date())).toBe(1);
    expect(c.p.refreshes).toEqual([]);
    expect((await conn(c.id)).status).toBe("REAUTH_REQUIRED");
  });

  it("연동 키가 없거나(provider null)·잠긴 파트너스·시간 예산이 0이면 쇼핑몰 API를 부르지 않는다", async () => {
    const a = await connected("keyoff");
    const b = await connected("locked");
    for (const x of [a, b]) await db.externalShopConnection.update({ where: { id: x.id }, data: { accessExpiresAt: new Date(Date.now() - 1000) } });
    expect(await refreshDueTokens(db, null, new Date())).toBe(0);
    await db.seller.update({ where: { id: b.seller.id }, data: { trialEndsAt: new Date(Date.now() - DAY) } });
    const p = new FakeProvider();
    expect(await refreshDueTokens(db, p, new Date(), 0)).toBe(0);
    expect(p.refreshes).toEqual([]);
    expect(await refreshDueTokens(db, p, new Date())).toBe(1);
    expect(p.refreshes).toEqual(["keyoff:RT-k"]);
  });
});

describe("다시 연결·목록 권한 (SA-006)", () => {
  async function connected(key = "myshop") {
    const s = await shop();
    const p = new FakeProvider();
    const st = await startConnect(db, p, s.ctx, `https://${key}.cafe24.com`);
    if (!st.ok) throw new Error("start");
    const r = await completeConnect(db, p, s.ctx, { state: stateOf(st.authorizeUrl), code: "k" });
    if (!r.ok) throw new Error("complete");
    return { ...s, p, id: r.connectionId };
  }

  it("다시 연결: 연결됨·다시 연결 필요 상태만 새 인증을 시작하고, 다른 파트너스·해제된 연결은 404", async () => {
    const a = await connected("shopa");
    await db.externalShopConnection.update({ where: { id: a.id }, data: { status: "REAUTH_REQUIRED" } });
    const r = await startReconnect(db, a.p, a.ctx, a.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(new URL(r.authorizeUrl).hostname).toBe("shopa.auth.test");
    // 새 인증을 마치면 같은 연결 행이 연결됨으로 돌아온다(행이 늘지 않는다)
    expect((await completeConnect(db, a.p, a.ctx, { state: stateOf(r.authorizeUrl), code: "again" })).ok).toBe(true);
    expect(await db.externalShopConnection.count()).toBe(1);
    expect(await db.externalShopConnection.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ status: "CONNECTED" });
    const other = await shop();
    await expect(startReconnect(db, a.p, other.ctx, a.id)).rejects.toMatchObject({ status: 404 });
    await db.externalShopConnection.update({ where: { id: a.id }, data: { status: "DISCONNECTED" } });
    await expect(startReconnect(db, a.p, a.ctx, a.id)).rejects.toMatchObject({ status: 404 });
    expect(await startReconnect(db, null, (await connected("shopb")).ctx, (await db.externalShopConnection.findFirstOrThrow({ where: { shopKey: "shopb" } })).id)).toEqual({ ok: false, reason: "integration_disabled" });
  });

  it("목록은 같은 파트너스의 권한 없는 직원도 보고(보기만), 다른 파트너스의 연결은 보이지 않는다. 라우트는 canManage를 알려 준다", async () => {
    const a = await connected("shopa");
    await connected("shopz");
    const viewer = await createSellerUser(a.seller.id, { permissions: [] });
    const viewerCtx: TenantContext = { ...a.ctx, actorId: viewer.id, isOwner: false, permissions: [] };
    expect((await listConnections(db, viewerCtx)).map((c) => c.shopKey)).toEqual(["shopa"]);
    await expect(startConnect(db, new FakeProvider(), viewerCtx, "https://other.cafe24.com")).rejects.toMatchObject({ status: 403 });
    const cookie = async (email: string) => {
      const r = await loginSeller(db, { email, password: PASSWORD }, {});
      if (!r.ok) throw new Error(r.reason);
      return `lo_seller=${r.token}`;
    };
    const H = (c: string) => ({ host: "localhost:3000", origin: "http://localhost:3000", cookie: c, "content-type": "application/json" });
    const asViewer = await listRoute(new Request("http://localhost:3000/api/seller/external-shops", { headers: H(await cookie(viewer.email)) }));
    expect(asViewer.status).toBe(200);
    expect(await asViewer.json()).toMatchObject({ canManage: false, connections: [{ shopKey: "shopa" }] });
    const asOwner = await listRoute(new Request("http://localhost:3000/api/seller/external-shops", { headers: H(await cookie(a.user.email)) }));
    expect(await asOwner.json()).toMatchObject({ canManage: true });
    // connectionId 형식이 틀리면 404
    const bad = await startRoute(new Request("http://localhost:3000/api/seller/external-shops", { method: "POST", headers: H(await cookie(a.user.email)), body: JSON.stringify({ connectionId: "nope" }) }));
    expect(bad.status).toBe(404);
  });
});

describe("웹훅 경로", () => {
  it("저장된 새 이벤트만 응답 뒤 처리를 예약하고(중복·인증 실패는 예약하지 않음) 응답 본문은 비어 있다", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, ENV);
    try {
      const s = await shop();
      const p = new FakeProvider();
      const st = await startConnect(db, p, s.ctx, "https://myshop.cafe24.com");
      if (!st.ok) throw new Error("start");
      await completeConnect(db, p, s.ctx, { state: stateOf(st.authorizeUrl), code: "k" });
      afterCalls.length = 0;
      const body = JSON.stringify({ event_no: 90001, resource: { mall_id: "myshop", order_id: "x1" } });
      const post = (key: string | null) => webhookRoute(new Request("http://localhost:3000/api/external/webhook", { method: "POST", headers: key ? { "x-api-key": key } : {}, body }));
      expect((await post(null)).status).toBe(401);
      expect((await post("wrong")).status).toBe(401);
      expect(afterCalls).toHaveLength(0);
      const ok = await post(ENV.EXTERNAL_WEBHOOK_API_KEY);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe("");
      expect(afterCalls).toHaveLength(1);
      expect((await post(ENV.EXTERNAL_WEBHOOK_API_KEY)).status).toBe(200);
      expect(afterCalls).toHaveLength(1);
      // 쇼핑몰 개발자센터의 WebHook TEST 샘플(연결 안 된 몰): 인증키가 맞으면 200이고 저장·처리 예약은 없다. 인증키가 틀리면 여전히 401
      const before = await db.externalWebhookEvent.count();
      const sample = JSON.stringify({ event_no: 90023, resource: { mall_id: "cafe24bestshop", order_id: "20200717-0029236" } });
      const sampleRes = await webhookRoute(new Request("http://localhost:3000/api/external/webhook", { method: "POST", headers: { "x-api-key": ENV.EXTERNAL_WEBHOOK_API_KEY }, body: sample }));
      expect(sampleRes.status).toBe(200);
      expect(await db.externalWebhookEvent.count()).toBe(before);
      expect(afterCalls).toHaveLength(1);
      expect((await webhookRoute(new Request("http://localhost:3000/api/external/webhook", { method: "POST", headers: { "x-api-key": "wrong" }, body: sample }))).status).toBe(401);
      await afterCalls[0](); // 예약된 처리가 오류 없이 끝난다(공급자 키가 있으면 처리 대상이 아닌 이벤트는 닫힘)
    } finally {
      process.env = saved;
    }
  });
});
