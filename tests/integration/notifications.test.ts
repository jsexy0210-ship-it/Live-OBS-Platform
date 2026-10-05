import type { SellerStaffPermission } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as adminGet } from "../../app/api/admin/notifications/route";
import { GET as sellerGet } from "../../app/api/seller/notifications/route";
import { POST as sellerRead } from "../../app/api/seller/notifications/read/route";
import { loginSeller } from "../../lib/server/auth/login";
import { createAdminSession } from "../../lib/server/auth/session";
import { prisma } from "../../lib/server/db";
import { PASSWORD, createAdmin, createBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 알림 센터(SA-130 · MA-002): 파트너스는 새 공지(파트너스·전체 대상 게시분 최근 14일)와 문의 답변을 처리 화면 링크와 함께 받고,
// 다른 쇼핑몰·직원의 남의 문의는 보지 못한다. 공지는 알림 센터를 열면 읽음, 문의 답변은 문의를 열어야 읽음. 마스터는 답변 대기 문의를 본다.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const req = (path: string, cookie: string, method = "GET") => new Request(BASE + path, { method, headers: { ...H, cookie } });
const json = async (r: Response) => ({ status: r.status, body: await r.json() });
async function login(sellerId: string, kind: "OWNER" | "STAFF" | { permissions: SellerStaffPermission[] }) {
  const u = await createSellerUser(sellerId, kind === "OWNER" ? "OWNER" : kind === "STAFF" ? { permissions: [] } : kind);
  const r = await loginSeller(db, { email: u.email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return { id: u.id, cookie: `lo_seller=${r.token}` };
}
async function adminCookie(role: "SUPER_ADMIN" | "OPERATIONS" | "CS" | "READ_ONLY") {
  const a = await createAdmin(role);
  return { id: a.id, cookie: `lo_admin=${(await createAdminSession(db, a.id, {})).token}` };
}
const feed = async (cookie: string) => json(await sellerGet(req("/api/seller/notifications", cookie)));
const DAY = 86_400_000;

async function notice(adminId: string, o: { title: string; audience?: "PARTNERS" | "PUBLIC" | "ALL"; publishedAt?: Date | null; deletedAt?: Date | null }) {
  return db.platformNotice.create({
    data: {
      title: o.title,
      body: "본문",
      category: "GENERAL",
      audience: o.audience ?? "PARTNERS",
      publishedAt: o.publishedAt === undefined ? new Date() : o.publishedAt,
      deletedAt: o.deletedAt ?? null,
      createdByAdminId: adminId,
      updatedByAdminId: adminId,
    },
  });
}
async function inquiry(sellerId: string, userId: string, o: { title: string; status?: "OPEN" | "ANSWERED"; adminAt?: Date | null; readAt?: Date | null }) {
  return db.platformInquiry.create({
    data: {
      sellerId,
      createdBySellerUserId: userId,
      category: "BILLING",
      title: o.title,
      status: o.status ?? "OPEN",
      lastAdminMessageAt: o.adminAt ?? null,
      sellerReadAt: o.readAt ?? null,
    },
  });
}

describe("파트너스 알림 센터", () => {
  it("로그인 없이는 401. 공지는 대상이 맞고 게시된 최근 14일 것만, 처리 화면 링크가 붙는다", async () => {
    const { seller } = await createSeller();
    const owner = await login(seller.id, "OWNER");
    const su = await adminCookie("SUPER_ADMIN");
    expect((await feed("")).status).toBe(401);
    const n1 = await notice(su.id, { title: "새 기능 안내" });
    await notice(su.id, { title: "전체 대상", audience: "ALL" });
    await notice(su.id, { title: "공개만", audience: "PUBLIC" });
    await notice(su.id, { title: "임시 저장", publishedAt: null });
    await notice(su.id, { title: "지운 공지", deletedAt: new Date() });
    await notice(su.id, { title: "오래된 공지", publishedAt: new Date(Date.now() - 15 * DAY) });
    const r = await feed(owner.cookie);
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { title: string }) => i.title).sort()).toEqual(["새 기능 안내", "전체 대상"]);
    expect(r.body.items.find((i: { id: string }) => i.id === `notice:${n1.id}`)).toMatchObject({ kind: "NOTICE", href: `/seller/notices/${n1.id}`, unread: true });
    expect(r.body.unreadCount).toBe(2);
  });

  it("알림 센터를 열었다고 남기면 공지는 읽음, 그 뒤 새 공지는 안 읽음", async () => {
    const { seller } = await createSeller();
    const owner = await login(seller.id, "OWNER");
    const su = await adminCookie("SUPER_ADMIN");
    await notice(su.id, { title: "이전 공지", publishedAt: new Date(Date.now() - 1000) });
    expect((await json(await sellerRead(req("/api/seller/notifications/read", owner.cookie, "POST")))).status).toBe(200);
    expect((await feed(owner.cookie)).body).toMatchObject({ unreadCount: 0 });
    await notice(su.id, { title: "새 공지", publishedAt: new Date(Date.now() + 5000) });
    const r = await feed(owner.cookie);
    expect(r.body.unreadCount).toBe(1);
    expect(r.body.items[0]).toMatchObject({ title: "새 공지", unread: true });
    expect(await db.sellerNotificationSeen.count()).toBe(1);
  });

  it("문의 답변은 열기 전까지 안 읽음이고, 답변 없는 문의는 나오지 않는다. 대표자는 쇼핑몰 전체, 직원은 자기 문의만, 다른 쇼핑몰은 안 보인다", async () => {
    const a = await createSeller();
    const b = await createSeller();
    const owner = await login(a.seller.id, "OWNER");
    const staff = await login(a.seller.id, "STAFF");
    const other = await login(b.seller.id, "OWNER");
    const t = new Date(Date.now() - 60_000);
    const mine = await inquiry(a.seller.id, staff.id, { title: "직원 문의", status: "ANSWERED", adminAt: t });
    const ownerOwn = await inquiry(a.seller.id, owner.id, { title: "대표 문의", status: "ANSWERED", adminAt: t, readAt: new Date() });
    await inquiry(a.seller.id, owner.id, { title: "답변 전", status: "OPEN" });
    await inquiry(b.seller.id, other.id, { title: "남의 쇼핑몰 문의", status: "ANSWERED", adminAt: t });
    const o = await feed(owner.cookie);
    expect(o.body.items.map((i: { title: string }) => i.title).sort()).toEqual(["대표 문의", "직원 문의"]);
    expect(o.body.items.find((i: { id: string }) => i.id === `inquiry:${mine.id}`)).toMatchObject({ kind: "INQUIRY_REPLY", href: `/seller/inquiries/${mine.id}`, unread: true });
    expect(o.body.items.find((i: { id: string }) => i.id === `inquiry:${ownerOwn.id}`)).toMatchObject({ unread: false });
    expect(o.body.unreadCount).toBe(1);
    const s = await feed(staff.cookie);
    expect(s.body.items.map((i: { title: string }) => i.title)).toEqual(["직원 문의"]);
    expect((await feed(other.cookie)).body.items.map((i: { title: string }) => i.title)).toEqual(["남의 쇼핑몰 문의"]);
  });
});

describe("마스터 알림 센터", () => {
  it("전 역할이 보고 로그인 없이는 401. 답변 대기(OPEN) 문의만 처리 화면 링크와 함께 나온다", async () => {
    const { seller } = await createSeller();
    const owner = await login(seller.id, "OWNER");
    const waiting = await inquiry(seller.id, owner.id, { title: "답변 부탁드립니다", status: "OPEN" });
    await inquiry(seller.id, owner.id, { title: "답변 끝", status: "ANSWERED", adminAt: new Date() });
    expect((await json(await adminGet(req("/api/admin/notifications", "")))).status).toBe(401);
    for (const role of ["SUPER_ADMIN", "OPERATIONS", "CS", "READ_ONLY"] as const) {
      const a = await adminCookie(role);
      const r = await json(await adminGet(req("/api/admin/notifications", a.cookie)));
      expect(r.status).toBe(200);
      expect(r.body.unreadCount).toBe(1);
      expect(r.body.items).toEqual([expect.objectContaining({ id: `inquiry:${waiting.id}`, kind: "INQUIRY_WAITING", href: `/admin/support/inquiries/${waiting.id}`, unread: true })]);
    }
  });

  it("파트너스 로그인으로는 마스터 알림을 볼 수 없다", async () => {
    const { seller } = await createSeller();
    const owner = await login(seller.id, "OWNER");
    expect([401, 403]).toContain((await json(await adminGet(req("/api/admin/notifications", owner.cookie)))).status);
  });
});

// 업무 알림(주문·재고·반품): 지금 데이터에서 만든다. 입금 확인 필요·결제 완료·재고 없음·반품·교환 요청.
describe("파트너스 업무 알림(입금 확인 필요·결제 완료·재고 없음·반품 요청)", () => {
  const HOUR = 3_600_000;
  async function world() {
    const { seller, grade } = await createSeller();
    const buyer = await createBuyer(seller.id, grade.id);
    let n = 0;
    const order = (o: Record<string, unknown> = {}) =>
      db.order.create({ data: { sellerId: seller.id, orderNo: ++n, buyerMemberId: buyer.id, broadcastNicknameSnapshot: "닉", totalAmount: 10000, ...o } });
    const product = async (name: string, o: { status?: "ON_SALE" | "SOLD_OUT" | "HIDDEN" | "DRAFT"; stocks?: number[]; deleted?: boolean } = {}) => {
      const p = await db.product.create({ data: { sellerId: seller.id, name, price: 1000, status: o.status ?? "ON_SALE", deletedAt: o.deleted ? new Date() : null } });
      for (const [i, stock] of (o.stocks ?? [0]).entries()) await db.productOption.create({ data: { sellerId: seller.id, productId: p.id, name: `옵션${i}`, stock } });
      return p;
    };
    const ret = (orderId: string, o: Record<string, unknown> = {}) =>
      db.returnRequest.create({ data: { sellerId: seller.id, orderId, buyerMemberId: buyer.id, kind: "RETURN", reason: "DEFECTIVE", ...o } });
    return { seller, buyer, order, product, ret };
  }
  const kinds = (b: { items: { kind: string }[] }) => b.items.map((i) => i.kind).sort();
  const byKind = (b: { items: { kind: string; title: string; href: string; id: string; unread: boolean }[] }, k: string) => b.items.filter((i) => i.kind === k);

  it("대표자는 4종을 처리 화면 링크와 함께 받는다(입금 확인 필요·결제 완료·재고 없음·반품 요청)", async () => {
    const w = await world();
    const owner = await login(w.seller.id, "OWNER");
    const dep = await w.order({ status: "PENDING_PAYMENT", paymentMethod: "BANK_TRANSFER" });
    const paid = await w.order({ status: "PAID", paymentMethod: "CARD", paidAt: new Date(Date.now() - HOUR) });
    const sold = await w.product("포켓몬 부스터", { stocks: [0, 0] });
    const retOrder = await w.order({ status: "PAID", paymentMethod: "CARD", paidAt: new Date(Date.now() - 2 * HOUR) });
    const ret = await w.ret(retOrder.id);
    const b = (await feed(owner.cookie)).body;
    expect(byKind(b, "DEPOSIT_PENDING")).toEqual([expect.objectContaining({ id: `deposit:${dep.id}`, title: `${dep.broadcastNicknameSnapshot} 님 주문 입금 확인 필요`, href: `/seller/orders/${dep.id}`, unread: true })]);
    expect(byKind(b, "ORDER_PAID").map((i: { id: string }) => i.id).sort()).toEqual([`paid:${paid.id}`, `paid:${retOrder.id}`].sort());
    expect(byKind(b, "OUT_OF_STOCK")).toEqual([expect.objectContaining({ id: `stock:${sold.id}`, title: "포켓몬 부스터 재고 없음", href: `/seller/products/${sold.id}` })]);
    expect(byKind(b, "RETURN_REQUESTED")).toEqual([expect.objectContaining({ id: `return:${ret.id}`, title: `${retOrder.broadcastNicknameSnapshot} 님 주문 반품 요청`, href: "/seller/returns" })]);
    // 한 건은 한 번만 나온다(같은 id 없음)
    expect(new Set(b.items.map((i: { id: string }) => i.id)).size).toBe(b.items.length);
  });

  it("제외 조건: 카드·결제수단 미정 결제 대기, 14일 지난 결제, 재고가 있는 옵션이 하나라도 있는 상품, 숨김·임시·품절 설정·지운 상품, 지운 옵션, 접수 대기가 아닌 반품", async () => {
    const w = await world();
    const owner = await login(w.seller.id, "OWNER");
    await w.order({ status: "PENDING_PAYMENT", paymentMethod: "CARD" });
    await w.order({ status: "PENDING_PAYMENT" });
    await w.order({ status: "PAID", paymentMethod: "CARD", paidAt: new Date(Date.now() - 15 * 24 * HOUR) });
    await w.product("재고 있음", { stocks: [0, 3] });
    await w.product("숨김", { status: "HIDDEN", stocks: [0] });
    await w.product("임시", { status: "DRAFT", stocks: [0] });
    await w.product("품절 설정", { status: "SOLD_OUT", stocks: [0] });
    await w.product("지운 상품", { stocks: [0], deleted: true });
    const noOpt = await db.product.create({ data: { sellerId: w.seller.id, name: "옵션 없음", price: 1000 } });
    const withDeleted = await w.product("지운 옵션만 재고", { stocks: [0] });
    await db.productOption.create({ data: { sellerId: w.seller.id, productId: withDeleted.id, name: "지움", stock: 9, deletedAt: new Date() } });
    // 상태마다 DB 제약이 요구하는 칸을 채운다(ReturnRequest_status_fields·completed_result)
    const at = new Date();
    const done: Record<string, Record<string, unknown>> = {
      ACCEPTED: { acceptedAt: at, fault: "BUYER" },
      RECEIVED: { acceptedAt: at, receivedAt: at, fault: "BUYER" },
      COMPLETED: { acceptedAt: at, receivedAt: at, completedAt: at, fault: "BUYER", refundAmount: 0 },
      REJECTED: { rejectedAt: at, rejectReason: "사유" },
      CANCELLED: { cancelledAt: at },
    };
    // 주문 하나에 반품 접수는 하나뿐이라 상태마다 주문을 따로 둔다
    for (const [status, extra] of Object.entries(done)) await w.ret((await w.order({ status: "PAID", paymentMethod: "CARD", paidAt: new Date(Date.now() - 20 * 24 * HOUR) })).id, { status, ...extra });
    const b = (await feed(owner.cookie)).body;
    expect(byKind(b, "DEPOSIT_PENDING")).toEqual([]);
    expect(byKind(b, "ORDER_PAID")).toEqual([]);
    expect(byKind(b, "RETURN_REQUESTED")).toEqual([]);
    // 지운 옵션의 재고는 세지 않으므로 「지운 옵션만 재고」는 재고 없음, 옵션이 하나도 없는 상품은 대상이 아니다
    expect(byKind(b, "OUT_OF_STOCK").map((i: { title: string }) => i.title)).toEqual(["지운 옵션만 재고 재고 없음"]);
    expect(noOpt.id).toBeTruthy();
  });

  it("처리하면 사라진다: 입금 확인되면 입금 확인 필요가 빠지고 결제 완료로 한 번만 나온다. 재고를 채우면 재고 없음이 빠진다", async () => {
    const w = await world();
    const owner = await login(w.seller.id, "OWNER");
    const dep = await w.order({ status: "PENDING_PAYMENT", paymentMethod: "BANK_TRANSFER" });
    const p = await w.product("카드", { stocks: [0] });
    let b = (await feed(owner.cookie)).body;
    expect(kinds(b)).toEqual(["DEPOSIT_PENDING", "OUT_OF_STOCK"]);
    await db.order.update({ where: { id: dep.id }, data: { status: "PAID", paidAt: new Date() } });
    await db.productOption.updateMany({ where: { productId: p.id }, data: { stock: 5 } });
    b = (await feed(owner.cookie)).body;
    expect(kinds(b)).toEqual(["ORDER_PAID"]);
    expect(b.items).toHaveLength(1);
  });

  it("쇼핑몰 격리: 다른 쇼핑몰의 주문·상품·반품은 나오지 않는다", async () => {
    const a = await world();
    const b = await world();
    const ownerA = await login(a.seller.id, "OWNER");
    const oB = await b.order({ status: "PAID", paymentMethod: "CARD", paidAt: new Date() });
    await b.order({ status: "PENDING_PAYMENT", paymentMethod: "BANK_TRANSFER" });
    await b.product("남의 상품", { stocks: [0] });
    await b.ret(oB.id);
    expect((await feed(ownerA.cookie)).body.items).toEqual([]);
    expect(kinds((await feed((await login(b.seller.id, "OWNER")).cookie)).body)).toEqual(["DEPOSIT_PENDING", "ORDER_PAID", "OUT_OF_STOCK", "RETURN_REQUESTED"]);
  });

  it("권한: 주문·반품은 주문·배송 권한, 재고는 상품 권한이 있어야 보인다. 공지·문의는 누구나", async () => {
    const w = await world();
    await w.order({ status: "PENDING_PAYMENT", paymentMethod: "BANK_TRANSFER" });
    const o = await w.order({ status: "PAID", paymentMethod: "CARD", paidAt: new Date() });
    await w.ret(o.id);
    await w.product("품절 상품", { stocks: [0] });
    const none = await login(w.seller.id, { permissions: [] });
    const ship = await login(w.seller.id, { permissions: ["ORDER_SHIPPING"] });
    const prod = await login(w.seller.id, { permissions: ["PRODUCT_MANAGE"] });
    const su = await adminCookie("SUPER_ADMIN");
    await db.platformNotice.create({ data: { title: "공지", body: "본문", category: "GENERAL", audience: "PARTNERS", publishedAt: new Date(), createdByAdminId: su.id, updatedByAdminId: su.id } });
    expect(kinds((await feed(none.cookie)).body)).toEqual(["NOTICE"]);
    expect(kinds((await feed(ship.cookie)).body)).toEqual(["DEPOSIT_PENDING", "NOTICE", "ORDER_PAID", "RETURN_REQUESTED"]);
    expect(kinds((await feed(prod.cookie)).body)).toEqual(["NOTICE", "OUT_OF_STOCK"]);
  });

  it("교환 요청은 제목이 다르고, 안 읽음은 마지막으로 본 시각 이후만이며, 종류별 10건까지만 준다", async () => {
    const w = await world();
    const owner = await login(w.seller.id, "OWNER");
    const o = await w.order({ status: "PAID", paymentMethod: "CARD", paidAt: new Date(Date.now() - 30 * HOUR) });
    await db.returnRequest.create({ data: { sellerId: w.seller.id, orderId: o.id, buyerMemberId: w.buyer.id, kind: "EXCHANGE", reason: "DEFECTIVE", createdAt: new Date(Date.now() - 20 * HOUR) } });
    expect(byKind((await feed(owner.cookie)).body, "RETURN_REQUESTED")[0].title).toBe(`${o.broadcastNicknameSnapshot} 님 주문 교환 요청`);
    // 읽음 처리 뒤에는 이전 알림이 읽음이고, 이후 생긴 것만 안 읽음
    await sellerRead(req("/api/seller/notifications/read", owner.cookie, "POST"));
    expect((await feed(owner.cookie)).body.unreadCount).toBe(0);
    await w.order({ status: "PENDING_PAYMENT", paymentMethod: "BANK_TRANSFER", createdAt: new Date(Date.now() + 5_000) });
    const b = (await feed(owner.cookie)).body;
    expect(b.unreadCount).toBe(1);
    expect(byKind(b, "DEPOSIT_PENDING")[0].unread).toBe(true);
    expect(byKind(b, "ORDER_PAID")[0].unread).toBe(false);
    // 종류별 최대 10건
    for (let i = 0; i < 14; i++) await w.order({ status: "PENDING_PAYMENT", paymentMethod: "BANK_TRANSFER" });
    expect(byKind((await feed(owner.cookie)).body, "DEPOSIT_PENDING")).toHaveLength(10);
  });
});
