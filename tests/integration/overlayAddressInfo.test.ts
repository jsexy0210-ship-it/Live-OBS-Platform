import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as publicLayout } from "../../app/api/overlay/[token]/layout/route";
import { GET as infoGet } from "../../app/api/seller/overlay/address-info/route";
import { POST as tokenPost } from "../../app/api/seller/overlay/token/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { parseClient } from "../../lib/server/overlay/access";
import { startBroadcast } from "../../lib/server/queue/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-052: 방송 화면 주소 정보(발급일·접속 기록·재발급 이력)와 방송 중 재발급 차단
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { "content-type": "application/json", host: "localhost:3000", origin: "http://localhost:3000" };
const OBS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 OBS/30.1.2";
const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  await db.sellerUser.update({ where: { id: owner.id }, data: { name: "김대표" } });
  const r = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, ctx, cookie: `lo_seller=${r.token}` };
}
const issue = async (cookie: string) => {
  const r = await tokenPost(new Request("http://localhost:3000/api/seller/overlay/token", { method: "POST", headers: { ...H, cookie }, body: "{}" }));
  return { status: r.status, body: await r.json() };
};
const info = async (cookie: string) => {
  const r = await infoGet(new Request("http://localhost:3000/api/seller/overlay/address-info", { headers: { ...H, cookie } }));
  return { status: r.status, body: await r.json() };
};
const open = (token: string, ua: string, aspect: string) =>
  publicLayout(new Request(`http://localhost:3000/api/overlay/${token}/layout?aspect=${aspect}`, { headers: { "user-agent": ua } }), { params: Promise.resolve({ token }) });

describe("사용자 에이전트 읽기", () => {
  it("OBS·브라우저·OS를 줄여 읽고 원문은 남기지 않는다", () => {
    expect(parseClient(OBS_UA)).toEqual({ client: "OBS 30.1 · Windows", isObs: true, short: "OBS" });
    expect(parseClient(MAC_UA)).toEqual({ client: "Chrome · macOS", isObs: false, short: "Chrome" });
    expect(parseClient(null)).toEqual({ client: "알 수 없음", isObs: false, short: "알 수 없음" });
  });
});

describe("방송 화면 주소 정보", () => {
  it("발급 전에는 비어 있고, 발급·접속·재발급이 기록에 쌓인다. 주소 원문은 없다", async () => {
    const s = await shop();
    expect((await info(s.cookie)).body).toMatchObject({ issuedAt: null, lastAccessAt: null, lastClient: null, connected: false, live: false, accesses: [], reissues: [] });
    const first = await issue(s.cookie);
    expect(first.status).toBe(200);
    expect((await open(first.body.token, OBS_UA, "9x16")).status).toBe(200);
    expect((await open(first.body.token, OBS_UA, "9x16")).status).toBe(200); // 같은 환경·레이아웃 10분 안 재접속은 한 줄
    expect((await open(first.body.token, MAC_UA, "16x9")).status).toBe(200);
    const a = await info(s.cookie);
    expect(a.status).toBe(200);
    expect(a.body.accesses.map((x: { client: string; layout: string; state: string }) => [x.client, x.layout, x.state])).toEqual([
      ["Chrome · macOS", "16x9", "unknown_browser"],
      ["OBS 30.1 · Windows", "9x16", "ended"],
    ]);
    expect(a.body.lastClient).toBe("Chrome");
    expect(a.body.issuedAt).toBeTruthy();
    expect(a.body.reissues).toEqual([{ at: expect.any(String), by: `${s.seller.shopName} · 김대표`, kind: "first" }]);
    expect(JSON.stringify(a.body)).not.toContain(first.body.token);
    const second = await issue(s.cookie);
    expect(second.status).toBe(200);
    const b = await info(s.cookie);
    expect(b.body.reissues.map((r: { kind: string }) => r.kind)).toEqual(["reissue", "first"]);
    // 재발급 뒤에도 이전 주소의 접속 기록은 남는다. 새 주소는 아직 접속이 없어 마지막 접속이 비어 있다
    expect(b.body.accesses).toHaveLength(2);
    expect(b.body.lastAccessAt).toBeNull();
  });

  it("폐기된 주소의 접속은 기록하지 않고, 다른 판매자는 서로 안 보인다", async () => {
    const a = await shop();
    const b = await shop();
    const ta = await issue(a.cookie);
    await issue(a.cookie);
    expect((await open(ta.body.token, OBS_UA, "9x16")).status).toBe(404);
    expect((await info(a.cookie)).body.accesses).toEqual([]);
    expect((await info(b.cookie)).body.reissues).toEqual([]);
  });

  it("접속 기록은 판매자당 최근 100건만 보관한다", async () => {
    const s = await shop();
    const t = await issue(s.cookie);
    const row = await db.overlayToken.findFirstOrThrow({ where: { sellerId: s.seller.id } });
    await db.overlayAccess.createMany({ data: Array.from({ length: 105 }, (_, i) => ({ sellerId: s.seller.id, tokenId: row.id, at: new Date(Date.UTC(2026, 0, 1) + i * 60_000), client: "Chrome · Windows", isObs: false, layout: "9x16" })) });
    await open(t.body.token, OBS_UA, "9x16");
    expect(await db.overlayAccess.count({ where: { sellerId: s.seller.id } })).toBe(100);
  });
});

describe("연결 상태·권한", () => {
  it("최근에 쓰인 주소는 연결 중, 오래되면 종료. 방송 화면 권한 없는 직원은 403", async () => {
    const s = await shop();
    const t = await issue(s.cookie);
    await open(t.body.token, OBS_UA, "9x16");
    await db.overlayToken.updateMany({ where: { sellerId: s.seller.id }, data: { lastSeenAt: new Date() } });
    const on = (await info(s.cookie)).body;
    expect([on.connected, on.lastClient, on.accesses[0].state]).toEqual([true, "OBS", "connected"]);
    await db.overlayToken.updateMany({ where: { sellerId: s.seller.id }, data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) } });
    const off = (await info(s.cookie)).body;
    expect([off.connected, off.accesses[0].state]).toEqual([false, "ended"]);
    const staff = await createSellerUser(s.seller.id, { permissions: [] });
    const r = await loginSeller(db, { email: staff.email, password: PASSWORD }, {});
    if (!r.ok) throw new Error(r.reason);
    expect((await info(`lo_seller=${r.token}`)).status).toBe(403);
    expect((await issue(`lo_seller=${r.token}`)).status).toBe(403);
  });
});

describe("방송 중 재발급", () => {
  it("방송 중에는 재발급이 409 live, 처음 발급은 방송 중에도 된다. 끝나면 다시 된다", async () => {
    const s = await shop();
    const live = await startBroadcast(db, s.ctx);
    if (!live.ok) throw new Error("start");
    expect((await issue(s.cookie)).status).toBe(200); // 살아 있는 주소가 없으면 처음 발급
    expect((await info(s.cookie)).body.live).toBe(true);
    const blocked = await issue(s.cookie);
    expect(blocked).toMatchObject({ status: 409, body: { error: "live" } });
    expect(await db.overlayToken.count({ where: { sellerId: s.seller.id, revokedAt: null } })).toBe(1);
    await db.broadcastSession.update({ where: { id: live.value.broadcastSessionId }, data: { status: "ENDED", endedAt: new Date() } });
    expect((await issue(s.cookie)).status).toBe(200);
  });
});
