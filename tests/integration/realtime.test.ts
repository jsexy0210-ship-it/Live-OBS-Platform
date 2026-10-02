import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET as sellerStream } from "../../app/api/seller/stream/route";
import { loginSeller } from "../../lib/server/auth/login";
import { revokeSession } from "../../lib/server/auth/session";
import { MAX_STREAMS_PER_KEY, SSE_CONFIG, openStreamCount } from "../../lib/server/realtime/sse";
import { hashToken } from "../../lib/server/auth/token";
import { GET as overlayState } from "../../app/api/overlay/[token]/state/route";
import { GET as overlayStream } from "../../app/api/overlay/[token]/stream/route";
import { prisma } from "../../lib/server/db";
import { issueOverlayToken } from "../../lib/server/overlay/token";
import { applyQueueAction, markOrderPaid, startBroadcast } from "../../lib/server/queue/service";
import { LiveHub, liveHub, type HubEvent } from "../../lib/server/realtime/hub";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
const DEFAULT_PING_MS = SSE_CONFIG.pingMs;
afterEach(() => {
  SSE_CONFIG.pingMs = DEFAULT_PING_MS;
});
afterAll(async () => {
  await liveHub().close();
  await db.$disconnect();
  await prisma.$disconnect();
});

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error("시간 초과");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function shop() {
  const { seller, grade } = await createSeller();
  const user = await createSellerUser(seller.id, "BROADCASTER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: user.id, isOwner: false, permissions: user.permissions, readOnly: false };
  const buyer = await createBuyer(seller.id, grade.id);
  const paidItem = async () => {
    const { order } = await createPaidOrderItem(seller.id, buyer.id);
    // createPaidOrderItem은 PAID로 만들므로 결제 대기로 되돌린 뒤 결제 완료 처리를 거친다
    await db.order.update({ where: { id: order.id }, data: { status: "PENDING_PAYMENT", paidAt: null } });
    const r = await markOrderPaid(db, { sellerId: seller.id, orderId: order.id });
    if (!r.ok) throw new Error(r.reason);
    return r.value.queueItemIds[0];
  };
  return { seller, ctx, buyer, paidItem };
}

describe("LISTEN/NOTIFY 허브", () => {
  it("주문대기 변경이 커밋되면 그 판매자 구독자에게만 새 version이 간다", async () => {
    const hub = new LiveHub(process.env.DATABASE_URL!);
    const a = await shop();
    const b = await shop();
    const gotA: HubEvent[] = [];
    const gotB: HubEvent[] = [];
    await hub.subscribe(a.seller.id, (e) => gotA.push(e));
    await hub.subscribe(b.seller.id, (e) => gotB.push(e));

    const r = await startBroadcast(db, a.ctx);
    if (!r.ok) throw new Error(r.reason);
    const ev = await waitFor(() => gotA.find((e) => e.type === "version" && e.version === r.version));
    expect(ev).toEqual({ type: "version", version: r.version });
    await new Promise((res) => setTimeout(res, 200));
    expect(gotB).toEqual([]);
    await hub.close();
  });

  it("거부된 변경은 알림을 보내지 않는다", async () => {
    const hub = new LiveHub(process.env.DATABASE_URL!);
    const a = await shop();
    const id = await a.paidItem();
    const got: HubEvent[] = [];
    await hub.subscribe(a.seller.id, (e) => got.push(e));
    expect(await applyQueueAction(db, a.ctx, id, "complete")).toMatchObject({ ok: false });
    await new Promise((res) => setTimeout(res, 300));
    expect(got).toEqual([]);
    await hub.close();
  });

  it("LISTEN 연결이 끊기면 다시 연결하고 모든 구독자에게 「다시 받기」를 보낸다", async () => {
    const hub = new LiveHub(process.env.DATABASE_URL!);
    const a = await shop();
    const got: HubEvent[] = [];
    await hub.subscribe(a.seller.id, (e) => got.push(e));
    await db.$queryRaw`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query = 'LISTEN live_obs' AND pid <> pg_backend_pid()`;
    await waitFor(() => got.find((e) => e.type === "resync"), 8000);
    // 다시 연결된 뒤에도 알림이 온다
    const r = await startBroadcast(db, a.ctx);
    if (!r.ok) throw new Error(r.reason);
    await waitFor(() => got.find((e) => e.type === "version" && e.version === r.version));
    await hub.close();
  }, 15000);
});

describe("LISTEN 연결 실패·점검", () => {
  it("처음 LISTEN 연결이 실패하면 구독은 오류를 던지고 리스너가 남지 않는다", async () => {
    const hub = new LiveHub("postgresql://nobody:nothing@127.0.0.1:1/none");
    for (let i = 0; i < 5; i++) await expect(hub.subscribe("s1", () => undefined)).rejects.toBeTruthy();
    expect(hub.subscriberCount("s1")).toBe(0);
    await hub.close();
  });

  it("점검 쿼리(SELECT 1)가 실패하면 다시 연결하고 「다시 받기」를 보낸다", async () => {
    const hub = new LiveHub(process.env.DATABASE_URL!, { healthCheckMs: 100, healthTimeoutMs: 100 });
    const a = await shop();
    const got: HubEvent[] = [];
    await hub.subscribe(a.seller.id, (e) => got.push(e));
    // 조용히 끊긴 연결처럼 응답이 오지 않게 만든다
    const inner = hub as unknown as { client: { query: (q: string) => Promise<unknown> } };
    inner.client.query = () => new Promise(() => undefined);
    await waitFor(() => got.find((e) => e.type === "resync"), 8000);
    const r = await startBroadcast(db, a.ctx);
    if (!r.ok) throw new Error(r.reason);
    await waitFor(() => got.find((e) => e.type === "version" && e.version === r.version));
    await hub.close();
  }, 15000);
});

// SSE 응답을 끝까지(닫힐 때까지) 읽는다. 시간 안에 닫히지 않으면 실패.
async function readToEnd(res: Response, timeoutMs = 5000): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const until = Date.now() + timeoutMs;
  for (;;) {
    const left = until - Date.now();
    if (left <= 0) throw new Error("스트림이 닫히지 않음");
    const chunk = await Promise.race([reader.read(), new Promise<null>((r) => setTimeout(() => r(null), left))]);
    if (chunk === null) throw new Error("스트림이 닫히지 않음");
    if (chunk.done) return text;
    text += decoder.decode(chunk.value);
  }
}

describe("SSE 연결 재확인·상한", () => {
  const params = (token: string) => ({ params: Promise.resolve({ token }) });
  const open = (token: string, signal?: AbortSignal) =>
    overlayStream(new Request(`http://localhost/api/overlay/${token}/stream`, { signal }), params(token));

  it("오버레이 토큰을 재발급하면 옛 토큰 스트림은 다음 확인 때 닫힌다", async () => {
    SSE_CONFIG.pingMs = 100;
    const a = await shop();
    const old = await issueOverlayToken(db, a.ctx);
    const res = await open(old);
    expect(res.status).toBe(200);
    await issueOverlayToken(db, a.ctx);
    const text = await readToEnd(res);
    expect(text).toContain("event: version");
    expect(openStreamCount(`overlay:${hashToken(old)}`)).toBe(0);
  });

  it("판매자 세션이 로그아웃되면 대시보드 스트림은 다음 확인 때 닫힌다", async () => {
    SSE_CONFIG.pingMs = 100;
    const a = await shop();
    const user = await db.sellerUser.findUniqueOrThrow({ where: { id: a.ctx.actorId } });
    const login = await loginSeller(db, { email: user.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const res = await sellerStream(new Request("http://localhost/api/seller/stream", { headers: { cookie: `lo_seller=${login.token}` } }));
    expect(res.status).toBe(200);
    await revokeSession(db, "seller", login.token);
    await readToEnd(res);
  });

  it("핑 재확인은 세션 최대 수명(expiresAt)을 늘리지 않고, 만료 시각이 지나면 대시보드 스트림을 닫는다", async () => {
    SSE_CONFIG.pingMs = 100;
    const a = await shop();
    const user = await db.sellerUser.findUniqueOrThrow({ where: { id: a.ctx.actorId } });
    const login = await loginSeller(db, { email: user.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const session = await db.sellerSession.findUniqueOrThrow({ where: { tokenHash: hashToken(login.token) } });
    const res = await sellerStream(new Request("http://localhost/api/seller/stream", { headers: { cookie: `lo_seller=${login.token}` } }));
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 400)); // 핑 재확인 몇 번
    expect((await db.sellerSession.findUniqueOrThrow({ where: { id: session.id } })).expiresAt).toEqual(session.expiresAt);
    await db.sellerSession.update({ where: { id: session.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await readToEnd(res);
  });

  it("토큰 하나로 동시에 10개까지 열 수 있고, 넘으면 429, 닫으면 다시 열 수 있다", async () => {
    const a = await shop();
    const token = await issueOverlayToken(db, a.ctx);
    const controllers = Array.from({ length: MAX_STREAMS_PER_KEY }, () => new AbortController());
    const opened = await Promise.all(controllers.map((c) => open(token, c.signal)));
    expect(opened.map((r) => r.status)).toEqual(Array(MAX_STREAMS_PER_KEY).fill(200));
    const over = await open(token);
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "too_many_streams" });
    controllers[0].abort();
    const again = new AbortController();
    expect((await open(token, again.signal)).status).toBe(200);
    for (const c of [...controllers, again]) c.abort();
    expect(openStreamCount(`overlay:${hashToken(token)}`)).toBe(0);
  });
});

describe("오버레이 API", () => {
  const params = (token: string) => ({ params: Promise.resolve({ token }) });

  it("SSE: 연결 직후 현재 version, 변경되면 새 version을 받는다", async () => {
    const a = await shop();
    const token = await issueOverlayToken(db, a.ctx);
    const ac = new AbortController();
    const res = await overlayStream(new Request(`http://localhost/api/overlay/${token}/stream`, { signal: ac.signal }), params(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const readUntil = async (needle: string) => {
      const until = Date.now() + 5000;
      while (!text.includes(needle)) {
        if (Date.now() > until) throw new Error(`시간 초과: ${needle}`);
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    const v0 = (await db.seller.findUniqueOrThrow({ where: { id: a.seller.id } })).liveVersion;
    await readUntil(`data: {"version":${v0}}`);
    const r = await startBroadcast(db, a.ctx);
    if (!r.ok) throw new Error(r.reason);
    await readUntil(`data: {"version":${r.version}}`);
    ac.abort();
    await reader.cancel().catch(() => undefined);
  });

  it("상태: 방송 화면용 최소 필드만 내보낸다 (회원 id·휴대폰·금액 없음)", async () => {
    const a = await shop();
    await startBroadcast(db, a.ctx);
    const id = await a.paidItem();
    await db.queueItem.update({ where: { id }, data: { nicknameSnapshot: "카드\u202e왕" } });
    await applyQueueAction(db, a.ctx, id, "start");
    const token = await issueOverlayToken(db, a.ctx);
    const res = await overlayState(new Request(`http://localhost/api/overlay/${token}/state`), params(token));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.opening).toMatchObject({ id, status: "OPENING", nickname: "카드왕", quantity: 1 });
    const raw = JSON.stringify(body);
    for (const key of ["buyerMemberId", "phone", "orderId", "orderItemId", "totalAmount", "unitPrice", "nicknameSnapshot", a.buyer.phone]) {
      expect(raw).not.toContain(key);
    }
  });

  it("재발급하면 이전 토큰은 404, 정지된 판매자 토큰도 404", async () => {
    const a = await shop();
    const old = await issueOverlayToken(db, a.ctx);
    const fresh = await issueOverlayToken(db, a.ctx);
    const get = (t: string) => overlayState(new Request(`http://localhost/api/overlay/${t}/state`), params(t));
    expect((await get(old)).status).toBe(404);
    expect((await get(fresh)).status).toBe(200);
    expect((await get("not-a-token")).status).toBe(404);
    await db.seller.update({ where: { id: a.seller.id }, data: { status: "SUSPENDED" } });
    expect((await get(fresh)).status).toBe(404);
  });

  it("오버레이 편집 권한(OVERLAY_EDIT)이 없는 직원은 토큰을 발급할 수 없다", async () => {
    const a = await shop();
    await expect(issueOverlayToken(db, { ...a.ctx, permissions: ["BROADCAST_RUN"] })).rejects.toMatchObject({ status: 403 });
  });

  it("마스터 대리 조회(읽기 전용)로는 오버레이 토큰을 발급할 수 없다", async () => {
    const a = await shop();
    await expect(issueOverlayToken(db, { ...a.ctx, actorType: "PLATFORM_ADMIN", isOwner: false, permissions: [], readOnly: true })).rejects.toMatchObject({
      status: 403,
    });
  });
});
