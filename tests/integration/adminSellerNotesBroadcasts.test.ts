import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as broadcastsRoute } from "../../app/api/admin/sellers/[sellerId]/broadcasts/route";
import { DELETE as noteDelete } from "../../app/api/admin/sellers/[sellerId]/notes/[noteId]/route";
import { GET as notesGet, POST as notesPost } from "../../app/api/admin/sellers/[sellerId]/notes/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { HISTORY_PAGE } from "../../lib/server/broadcast/history";
import { PASSWORD, createBuyer, createPaidOrderItem, createSeller, createSellerUser, createAdmin, db, resetDb } from "./helpers";

// 마스터 관리자 파트너스 상세(MA-012) 탭용: 파트너스 관리자 메모(목록·추가·삭제)와 파트너스별 방송 이력.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

const H = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };
type Role = "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY";
async function admin(role: Role) {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
const sid = (id: string) => ({ params: Promise.resolve({ sellerId: id }) });
const listNotes = async (cookie: string, id: string, qs = "") => {
  const r = await notesGet(new Request(`http://localhost:3000/x${qs}`, { headers: { ...H, cookie } }), sid(id));
  return { status: r.status, body: await r.json() };
};
const addNote = async (cookie: string, id: string, body: unknown) => {
  const r = await notesPost(new Request("http://localhost:3000/x", { method: "POST", headers: { ...H, cookie }, body: JSON.stringify({ body }) }), sid(id));
  return { status: r.status, body: await r.json() };
};
const delNote = async (cookie: string, id: string, noteId: string) => {
  const r = await noteDelete(new Request("http://localhost:3000/x", { method: "DELETE", headers: { ...H, cookie } }), { params: Promise.resolve({ sellerId: id, noteId }) });
  return { status: r.status, body: await r.json() };
};
const history = async (cookie: string, id: string, qs = "") => {
  const r = await broadcastsRoute(new Request(`http://localhost:3000/x${qs}`, { headers: { ...H, cookie } }), sid(id));
  return { status: r.status, body: await r.json() };
};

describe("파트너스 관리자 메모", () => {
  it("추가·목록(최신순·작성자·삭제 가능 여부)·삭제, 로그 추적에는 본문 없이 글자 수만 남는다", async () => {
    const { seller } = await createSeller();
    const cs = await admin("CS");
    const a = await addNote(cs.cookie, seller.id, "결제 카드 변경 문의\n다음 주 재연락");
    expect(a.status).toBe(201);
    expect(a.body.note).toMatchObject({ body: "결제 카드 변경 문의\n다음 주 재연락", author: { id: cs.id, name: "관리자" }, canDelete: true });
    await new Promise((r) => setTimeout(r, 5));
    const b = await addNote(cs.cookie, seller.id, "두 번째 메모");
    const l = await listNotes(cs.cookie, seller.id);
    expect(l.body.notes.map((n: { id: string }) => n.id)).toEqual([b.body.note.id, a.body.note.id]);
    expect(l.body.nextCursor).toBeNull();
    expect((await delNote(cs.cookie, seller.id, a.body.note.id)).body).toEqual({ ok: true });
    expect((await listNotes(cs.cookie, seller.id)).body.notes).toHaveLength(1);
    const logs = await db.auditLog.findMany({ where: { sellerId: seller.id, action: { startsWith: "admin.seller.note." } }, orderBy: { createdAt: "asc" } });
    expect(logs.map((x) => x.action)).toEqual(["admin.seller.note.create", "admin.seller.note.create", "admin.seller.note.delete"]);
    expect(logs.every((x) => x.actorType === "PLATFORM_ADMIN" && x.actorId === cs.id)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain("결제 카드");
    expect(logs[0].after).toMatchObject({ length: 20 });
  });

  it("조회 전용은 읽기만(추가·삭제 403), 최고관리자·운영·CS는 쓰기, 삭제는 쓴 사람 본인과 최고관리자만", async () => {
    const { seller } = await createSeller();
    const [ro, ops, cs, su] = [await admin("READ_ONLY"), await admin("OPERATIONS"), await admin("CS"), await admin("SUPER_ADMIN")];
    const mine = await addNote(ops.cookie, seller.id, "운영 메모");
    expect(mine.status).toBe(201);
    expect((await addNote(ro.cookie, seller.id, "조회 전용")).status).toBe(403);
    expect((await addNote(cs.cookie, seller.id, "CS 메모")).status).toBe(201);
    expect((await addNote(su.cookie, seller.id, "최고관리자 메모")).status).toBe(201);
    // 읽기는 전 역할, canDelete는 본인 것과 최고관리자 기준
    const asRo = await listNotes(ro.cookie, seller.id);
    expect(asRo.status).toBe(200);
    expect(asRo.body.notes).toHaveLength(3);
    expect(asRo.body.notes.every((n: { canDelete: boolean }) => n.canDelete === false)).toBe(true);
    expect((await listNotes(cs.cookie, seller.id)).body.notes.filter((n: { canDelete: boolean }) => n.canDelete)).toHaveLength(1);
    expect((await listNotes(su.cookie, seller.id)).body.notes.every((n: { canDelete: boolean }) => n.canDelete)).toBe(true);
    expect((await delNote(ro.cookie, seller.id, mine.body.note.id)).status).toBe(403);
    expect((await delNote(cs.cookie, seller.id, mine.body.note.id)).status).toBe(403);
    expect(await db.sellerAdminNote.count()).toBe(3);
    expect((await delNote(su.cookie, seller.id, mine.body.note.id)).status).toBe(200);
    expect(await db.sellerAdminNote.count()).toBe(2);
  });

  it("글자·길이 검사, 없는 파트너스·다른 파트너스의 메모 id는 404, 파트너스 세션·로그인 없음은 접근 불가, 커서 페이지", async () => {
    const a = (await createSeller()).seller;
    const b = (await createSeller()).seller;
    const su = await admin("SUPER_ADMIN");
    for (const bad of ["", "   ", 5, null, "가".repeat(1001)]) expect((await addNote(su.cookie, a.id, bad)).status, String(bad)).toBe(400);
    expect((await addNote(su.cookie, a.id, "가".repeat(1000))).status).toBe(201);
    expect((await addNote(su.cookie, "abc", "x")).status).toBe(404);
    expect((await addNote(su.cookie, "00000000-0000-4000-8000-000000000000", "x")).status).toBe(404);
    expect((await listNotes(su.cookie, "abc")).status).toBe(404);
    // 다른 파트너스 경로로는 지울 수 없다
    const n = await addNote(su.cookie, b.id, "B의 메모");
    expect((await delNote(su.cookie, a.id, n.body.note.id)).status).toBe(404);
    expect(await db.sellerAdminNote.count({ where: { sellerId: b.id } })).toBe(1);
    expect((await listNotes(su.cookie, a.id)).body.notes.map((x: { body: string }) => x.body.length)).toEqual([1000]);
    // 파트너스 세션·로그인 없음
    const owner = await createSellerUser(a.id, "OWNER");
    const sl = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!sl.ok) throw new Error(sl.reason);
    expect((await listNotes(`lo_seller=${sl.token}`, a.id)).status).toBe(401);
    expect((await addNote("", a.id, "x")).status).toBe(401);
    // 커서
    for (let i = 0; i < 3; i++) {
      await addNote(su.cookie, b.id, `메모${i}`);
      await new Promise((r) => setTimeout(r, 3));
    }
    const p1 = await listNotes(su.cookie, b.id, "?limit=2");
    expect(p1.body.notes).toHaveLength(2);
    const p2 = await listNotes(su.cookie, b.id, `?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.notes).toHaveLength(2);
    expect(p2.body.nextCursor).toBeNull();
    expect(new Set([...p1.body.notes, ...p2.body.notes].map((x: { id: string }) => x.id)).size).toBe(4);
    expect((await listNotes(su.cookie, b.id, "?limit=0")).status).toBe(400);
    expect((await listNotes(su.cookie, b.id, "?cursor=zzz")).status).toBe(400);
  });
});

describe("파트너스별 방송 이력 GET /api/admin/sellers/{id}/broadcasts", () => {
  const MIN = 60_000;
  const session = (sellerId: string, startedAt: Date, title: string) =>
    db.broadcastSession.create({ data: { sellerId, status: "ENDED", title, startedAt, endedAt: new Date(startedAt.getTime() + 60 * MIN) } });

  it("그 파트너스의 방송만 최신순·집계·기간(KST)·다음 쪽으로 주고, 전 마스터 역할이 볼 수 있다", async () => {
    const { seller: s, grade } = await createSeller();
    const t = (await createSeller()).seller;
    const buyer = await createBuyer(s.id, grade.id);
    const late = await session(s.id, new Date("2026-10-01T23:30:00+09:00"), "밤 방송");
    const day2 = await session(s.id, new Date("2026-10-02T20:00:00+09:00"), "금요 방송");
    const { order } = await createPaidOrderItem(s.id, buyer.id);
    await db.order.update({ where: { id: order.id }, data: { createdAt: new Date("2026-10-02T20:10:00+09:00"), paidAt: new Date("2026-10-02T20:10:00+09:00") } });
    await session(t.id, new Date("2026-10-02T21:00:00+09:00"), "남의 방송");
    for (const role of ["READ_ONLY", "CS", "OPERATIONS", "SUPER_ADMIN"] as Role[]) {
      const r = await history((await admin(role)).cookie, s.id);
      expect(r.status, role).toBe(200);
      expect(r.body.items.map((b: { id: string }) => b.id)).toEqual([day2.id, late.id]);
      expect(r.body.items[0]).toMatchObject({ title: "금요 방송", status: "ended", summary: { orders: 1, paidOrders: 1, sales: 5000 } });
    }
    const su = (await admin("SUPER_ADMIN")).cookie;
    expect((await history(su, s.id, "?from=2026-10-01&to=2026-10-01")).body.items.map((b: { id: string }) => b.id)).toEqual([late.id]);
    expect((await history(su, t.id)).body.items.map((b: { title: string }) => b.title)).toEqual(["남의 방송"]);
    expect((await history(su, s.id, "?from=2026-10-03&to=2026-10-02")).status).toBe(400);
    expect((await history(su, s.id, "?from=2026-02-30")).body).toMatchObject({ error: "invalid_range" });
  });

  it("다음 쪽(HISTORY_PAGE+1건)·없는 파트너스 404·파트너스 세션 401", async () => {
    const { seller: s } = await createSeller();
    const su = (await admin("SUPER_ADMIN")).cookie;
    const base = new Date("2026-10-01T00:00:00Z").getTime();
    await db.broadcastSession.createMany({ data: Array.from({ length: HISTORY_PAGE + 1 }, (_, i) => ({ sellerId: s.id, status: "ENDED" as const, startedAt: new Date(base + i * MIN * 90), endedAt: new Date(base + i * MIN * 90 + MIN) })) });
    const p1 = await history(su, s.id);
    expect(p1.body.items).toHaveLength(HISTORY_PAGE);
    const p2 = await history(su, s.id, `?cursor=${p1.body.nextCursor}`);
    expect(p2.body.items).toHaveLength(1);
    expect(p2.body.nextCursor).toBeNull();
    expect((await history(su, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
    expect((await history(su, "abc")).status).toBe(404);
    const owner = await createSellerUser(s.id, "OWNER");
    const sl = await loginSeller(db, { email: owner.email, password: PASSWORD }, {});
    if (!sl.ok) throw new Error(sl.reason);
    expect((await history(`lo_seller=${sl.token}`, s.id)).status).toBe(401);
    expect((await history("", s.id)).status).toBe(401);
  });
});
