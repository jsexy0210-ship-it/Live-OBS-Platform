import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as sellerGetOne } from "../../app/api/seller/platform-notices/[noticeId]/route";
import { POST as sellerRead } from "../../app/api/seller/platform-notices/[noticeId]/read/route";
import { GET as sellerList } from "../../app/api/seller/platform-notices/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { PLATFORM_NOTICE_MESSAGES, SEARCH_MAX } from "../../lib/server/platform-notices/service";
import { PASSWORD, createAdmin, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 파트너스 공지(SA-111·112): 읽음 표시(계정별)·검색·분류 필터·안 읽은 것만·이전/다음·관련 공지
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const get = (path: string, cookie: string) => new Request(BASE + path, { headers: { ...H, cookie } });
const post = (path: string, cookie: string) => new Request(BASE + path, { method: "POST", headers: { ...H, cookie, "content-type": "application/json" }, body: "{}" });
const idp = (noticeId: string) => ({ params: Promise.resolve({ noticeId }) });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });

async function account(sellerId: string, owner: boolean) {
  const u = await createSellerUser(sellerId, owner ? "OWNER" : { permissions: [] });
  const r = await loginSeller(db, { email: u.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return { user: u, cookie: `lo_seller=${r.token}` };
}

async function notice(over: Record<string, unknown>, at: string) {
  const admin = await createAdmin("CS");
  return db.platformNotice.create({
    data: {
      title: "공지",
      body: "본문",
      category: "GENERAL",
      audience: "PARTNERS",
      isPinned: false,
      publishedAt: new Date(at),
      createdByAdminId: admin.id,
      updatedByAdminId: admin.id,
      ...over,
    },
  });
}

describe("목록: 읽음·검색·분류·안 읽은 것만", () => {
  it("항목마다 read(계정별)와 unreadCount를 주고, 읽음 API는 한 번만 남기며 계정끼리 섞이지 않는다", async () => {
    const { seller } = await createSeller();
    const a = await account(seller.id, true);
    const b = await account(seller.id, false);
    const n1 = await notice({ title: "첫째" }, "2026-10-01T00:00:00Z");
    const n2 = await notice({ title: "둘째" }, "2026-10-02T00:00:00Z");
    const pinned = await notice({ title: "고정", isPinned: true }, "2026-09-01T00:00:00Z");

    let l = await json(await sellerList(get("/api/seller/platform-notices", a.cookie)));
    expect(l.body.unreadCount).toBe(3);
    expect(l.body.pinned.map((x: { id: string; read: boolean }) => [x.id, x.read])).toEqual([[pinned.id, false]]);
    expect(l.body.items.map((x: { id: string; read: boolean }) => [x.id, x.read])).toEqual([[n2.id, false], [n1.id, false]]);

    const r1 = await json(await sellerRead(post(`/api/seller/platform-notices/${n2.id}/read`, a.cookie), idp(n2.id)));
    expect(r1).toEqual({ status: 200, body: { read: true, unreadCount: 2 } });
    // 다시 불러도 같다(한 줄)
    expect((await json(await sellerRead(post(`/api/seller/platform-notices/${n2.id}/read`, a.cookie), idp(n2.id)))).body).toEqual({ read: true, unreadCount: 2 });
    expect(await db.platformNoticeRead.count({ where: { noticeId: n2.id } })).toBe(1);
    await sellerRead(post(`/api/seller/platform-notices/${pinned.id}/read`, a.cookie), idp(pinned.id));

    l = await json(await sellerList(get("/api/seller/platform-notices", a.cookie)));
    expect(l.body.unreadCount).toBe(1);
    expect(l.body.pinned[0].read).toBe(true);
    expect(l.body.items.map((x: { id: string; read: boolean }) => [x.id, x.read])).toEqual([[n2.id, true], [n1.id, false]]);
    // 같은 쇼핑몰의 다른 계정은 아직 하나도 안 읽었다
    l = await json(await sellerList(get("/api/seller/platform-notices", b.cookie)));
    expect(l.body.unreadCount).toBe(3);
    expect(l.body.items.every((x: { read: boolean }) => x.read === false)).toBe(true);

    // 안 읽은 것만
    l = await json(await sellerList(get("/api/seller/platform-notices?unread=1", a.cookie)));
    expect(l.body.items.map((x: { id: string }) => x.id)).toEqual([n1.id]);
    expect(l.body.pinned).toEqual([]);
    // 다른 쇼핑몰 파트너스의 읽음은 영향이 없다
    const other = await createSeller();
    const o = await account(other.seller.id, true);
    expect((await json(await sellerList(get("/api/seller/platform-notices", o.cookie)))).body.unreadCount).toBe(3);
  });

  it("검색(제목·본문, 대소문자 무시, % _ 글자 그대로)·분류 필터·고정 공지도 같은 조건·커서와 함께 쓴다", async () => {
    const { seller } = await createSeller();
    const a = await account(seller.id, true);
    const m = await notice({ title: "정기 점검 안내", body: "새벽에 서버를 점검합니다", category: "MAINTENANCE" }, "2026-10-03T00:00:00Z");
    await notice({ title: "정책 변경", body: "수수료 안내 100% 환불", category: "POLICY" }, "2026-10-02T00:00:00Z");
    const f = await notice({ title: "New Feature Launch", body: "OBS 연동", category: "FEATURE" }, "2026-10-01T00:00:00Z");
    const pinnedM = await notice({ title: "점검 고정", category: "MAINTENANCE", isPinned: true }, "2026-09-20T00:00:00Z");
    const q = async (qs: string) => json(await sellerList(get(`/api/seller/platform-notices?${qs}`, a.cookie)));

    expect((await q(`q=${encodeURIComponent("점검")}`)).body).toMatchObject({ pinned: [{ id: pinnedM.id }], items: [{ id: m.id }] });
    expect((await q("q=new%20feature")).body.items.map((x: { id: string }) => x.id)).toEqual([f.id]);
    expect((await q(`q=${encodeURIComponent("서버를")}`)).body.items.map((x: { id: string }) => x.id)).toEqual([m.id]); // 본문
    expect((await q("q=%25")).body.items).toHaveLength(1); // % 는 와일드카드가 아니라 글자(「100%」 한 건)
    expect((await q("q=_")).body.items).toHaveLength(0);
    expect((await q("category=MAINTENANCE")).body).toMatchObject({ pinned: [{ id: pinnedM.id }], items: [{ id: m.id }] });
    expect((await q("category=FEATURE&q=obs")).body.items.map((x: { id: string }) => x.id)).toEqual([f.id]);
    expect((await q("category=POLICY&q=obs")).body.items).toEqual([]);
    // 조건과 상관없이 unreadCount는 안 읽은 공지 전체
    expect((await q("category=POLICY")).body.unreadCount).toBe(4);
    // 형식이 틀리면 400과 문구
    for (const [qs, error] of [["category=NOPE", "invalid_category"], [`q=${"가".repeat(SEARCH_MAX + 1)}`, "invalid_query"], ["cursor=bad", "invalid_cursor"]] as const) {
      expect(await q(qs)).toEqual({ status: 400, body: { error, message: PLATFORM_NOTICE_MESSAGES[error] } });
    }
    // 커서와 함께: 검색 결과 안에서 이어진다
    for (let i = 0; i < 22; i++) await notice({ title: `점검 ${i}`, category: "MAINTENANCE" }, `2026-08-${String(1 + (i % 28)).padStart(2, "0")}T0${i % 10}:00:00Z`);
    const first = await q(`category=MAINTENANCE`);
    expect(first.body.items).toHaveLength(20);
    const second = await q(`category=MAINTENANCE&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.pinned).toEqual([]);
    expect(second.body.items.length + first.body.items.length).toBe(23);
    expect(new Set([...first.body.items, ...second.body.items].map((x: { id: string }) => x.id)).size).toBe(23);
    expect(second.body.nextCursor).toBeNull();
  });
});

describe("상세: 이전/다음·관련 공지·읽음", () => {
  it("prev(더 최근)·next(더 오래된)는 고정과 무관한 게시일 순서, 관련 공지는 같은 분류 최근 3개(자기 제외), 열기만 해서는 읽음 처리 안 함", async () => {
    const { seller } = await createSeller();
    const a = await account(seller.id, true);
    const n1 = await notice({ title: "1", category: "POLICY" }, "2026-10-01T00:00:00Z");
    const n2 = await notice({ title: "2", category: "MAINTENANCE" }, "2026-10-02T00:00:00Z");
    const n3 = await notice({ title: "3", category: "POLICY", isPinned: true }, "2026-10-03T00:00:00Z");
    const n4 = await notice({ title: "4", category: "POLICY" }, "2026-10-04T00:00:00Z");
    const n5 = await notice({ title: "5", category: "POLICY" }, "2026-10-05T00:00:00Z");
    const n6 = await notice({ title: "6", category: "POLICY" }, "2026-10-06T00:00:00Z");
    await notice({ title: "공개 전용", category: "POLICY", audience: "PUBLIC" }, "2026-10-07T00:00:00Z"); // 파트너스에 안 보임
    await notice({ title: "임시 저장", category: "POLICY", publishedAt: null }, "2026-10-08T00:00:00Z");
    await notice({ title: "삭제", category: "POLICY", deletedAt: new Date() }, "2026-10-09T00:00:00Z");

    const one = async (n: { id: string }) => json(await sellerGetOne(get(`/api/seller/platform-notices/${n.id}`, a.cookie), idp(n.id)));
    const d4 = await one(n4);
    expect(d4.status).toBe(200);
    expect(d4.body.notice).toMatchObject({ id: n4.id, title: "4", body: "본문", read: false, prev: { id: n5.id, title: "5", category: "POLICY" }, next: { id: n3.id } });
    expect(d4.body.notice.related.map((x: { id: string }) => x.id)).toEqual([n6.id, n5.id, n3.id]); // 같은 분류만, 최근 3개, 자기 제외
    // 맨 위·맨 아래는 null
    expect((await one(n6)).body.notice).toMatchObject({ prev: null, next: { id: n5.id } });
    expect((await one(n1)).body.notice).toMatchObject({ next: null, prev: { id: n2.id } });
    expect((await one(n2)).body.notice.related.map((x: { id: string }) => x.id)).toEqual([]); // 분류가 혼자
    expect(await db.platformNoticeRead.count()).toBe(0); // 열기만 해서는 읽음 처리하지 않는다

    await sellerRead(post(`/api/seller/platform-notices/${n4.id}/read`, a.cookie), idp(n4.id));
    expect((await one(n4)).body.notice.read).toBe(true);
    // 없는·공개 전용·임시 저장·삭제 공지는 404, 읽음도 404
    const hidden = await db.platformNotice.findMany({ where: { OR: [{ audience: "PUBLIC" }, { publishedAt: null }, { deletedAt: { not: null } }] } });
    expect(hidden).toHaveLength(3);
    for (const h of hidden) {
      expect((await one(h)).status).toBe(404);
      expect((await sellerRead(post(`/api/seller/platform-notices/${h.id}/read`, a.cookie), idp(h.id))).status).toBe(404);
    }
    expect((await sellerRead(post("/api/seller/platform-notices/not-a-uuid/read", a.cookie), idp("not-a-uuid"))).status).toBe(404);
    // 로그인 없이는 읽음을 남길 수 없다
    expect((await sellerRead(post(`/api/seller/platform-notices/${n4.id}/read`, ""), idp(n4.id))).status).toBe(401);
  });

  it("같은 시각에 게시된 공지도 id로 순서가 고정되어 prev·next가 서로 맞물린다", async () => {
    const { seller } = await createSeller();
    const a = await account(seller.id, true);
    const at = "2026-10-01T00:00:00Z";
    const rows = [await notice({ title: "가" }, at), await notice({ title: "나" }, at), await notice({ title: "다" }, at)];
    const list = (await json(await sellerList(get("/api/seller/platform-notices", a.cookie)))).body.items.map((x: { id: string }) => x.id) as string[];
    expect(new Set(list)).toEqual(new Set(rows.map((r) => r.id)));
    for (let i = 0; i < list.length; i++) {
      const d = (await json(await sellerGetOne(get(`/api/seller/platform-notices/${list[i]}`, a.cookie), idp(list[i])))).body.notice;
      expect(d.prev?.id ?? null).toBe(list[i - 1] ?? null);
      expect(d.next?.id ?? null).toBe(list[i + 1] ?? null);
    }
  });
});
