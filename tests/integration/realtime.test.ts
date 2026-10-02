import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as overlayState } from "../../app/api/overlay/[token]/state/route";
import { GET as overlayStream } from "../../app/api/overlay/[token]/stream/route";
import { prisma } from "../../lib/server/db";
import { issueOverlayToken } from "../../lib/server/overlay/token";
import { applyQueueAction, markOrderPaid, startBroadcast } from "../../lib/server/queue/service";
import { LiveHub, liveHub, type HubEvent } from "../../lib/server/realtime/hub";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

beforeEach(resetDb);
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
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: user.id, sellerRole: "BROADCASTER", readOnly: false };
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

  it("마스터 대리 조회(읽기 전용)로는 오버레이 토큰을 발급할 수 없다", async () => {
    const a = await shop();
    await expect(issueOverlayToken(db, { ...a.ctx, actorType: "PLATFORM_ADMIN", sellerRole: null, readOnly: true })).rejects.toMatchObject({
      status: 403,
    });
  });
});
