import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DELETE as delRoute, PUT as putRoute } from "../../app/api/seller/notices/[noticeId]/route";
import { PUT as orderRoute } from "../../app/api/seller/notices/faq-order/route";
import { GET as sellerList, POST as createRoute } from "../../app/api/seller/notices/route";
import { GET as faqsRoute } from "../../app/api/shop/[slug]/faqs/route";
import { GET as noticeRoute } from "../../app/api/shop/[slug]/notices/[noticeId]/route";
import { GET as noticesRoute } from "../../app/api/shop/[slug]/notices/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { NOTICE_MESSAGES, PUBLIC_PAGE_SIZE } from "../../lib/server/shop-notice/service";
import { PASSWORD, createSeller, createSellerUser, db, resetDb } from "./helpers";

// SA-066 쇼핑몰 공지·자주 묻는 질문 관리 + SH-030 구매자 조회: 권한·판매자 격리·홈 띠 고정 1개·순서·공개 여부·검색·감사 로그.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
const H = { host: "localhost:3000", origin: BASE };
const json = (path: string, method: string, cookie: string, body?: unknown) =>
  new Request(BASE + path, { method, headers: { ...H, "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const get = (path: string, cookie?: string) => new Request(BASE + path, { headers: { ...H, ...(cookie ? { cookie } : {}) } });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

async function cookieOf(email: string) {
  const r = await loginSeller(db, { email, password: PASSWORD }, {});
  if (!r.ok) throw new Error(r.reason);
  return `lo_seller=${r.token}`;
}
async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const staff = await createSellerUser(seller.id, { permissions: ["SHOP_SETTINGS"] });
  const other = await createSellerUser(seller.id, { permissions: ["PRODUCT_MANAGE"] });
  return { seller, owner: await cookieOf(owner.email), staff: await cookieOf(staff.email), noPerm: await cookieOf(other.email) };
}

type Notice = { id: string; kind: string; title: string; isPinned: boolean; isPublished: boolean; category: string | null; sortOrder: number };
const create = async (cookie: string, body: unknown) => {
  const res = await createRoute(json("/api/seller/notices", "POST", cookie, body));
  return { res, body: (await res.json()) as { notice?: Notice; error?: string; message?: string } };
};
const put = (cookie: string, id: string, body: unknown) => putRoute(json(`/api/seller/notices/${id}`, "PUT", cookie, body), p({ noticeId: id }));
const list = async (cookie: string, kind: string) => (await (await sellerList(get(`/api/seller/notices?kind=${kind}`, cookie))).json()) as { items: Notice[] };
const pubNotices = (slug: string, q = "") => noticesRoute(get(`/api/shop/${slug}/notices${q}`), p({ slug }));
const pubFaqs = (slug: string, q = "") => faqsRoute(get(`/api/shop/${slug}/faqs${q}`), p({ slug }));

describe("파트너스 관리자 공지·질문", () => {
  it("대표자·쇼핑몰 설정 직원만 쓰고, 다른 직원은 보기만 한다", async () => {
    const s = await shop();
    expect((await create(s.owner, { kind: "notice", title: "배송 안내", body: "주문 다음 날 보내요" })).res.status).toBe(201);
    expect((await create(s.staff, { kind: "faq", title: "언제 와요?", body: "1~2일", category: "배송" })).res.status).toBe(201);
    expect((await create(s.noPerm, { kind: "notice", title: "x", body: "y" })).res.status).toBe(403);
    expect((await list(s.noPerm, "notice")).items.map((n) => n.title)).toEqual(["배송 안내"]);
    expect((await list(s.noPerm, "faq")).items.map((n) => [n.title, n.category])).toEqual([["언제 와요?", "배송"]]);
    expect((await sellerList(get("/api/seller/notices?kind=x", s.owner))).status).toBe(400);
    const audits = await db.auditLog.findMany({ where: { sellerId: s.seller.id, action: "shop.notice.create" } });
    expect(audits).toHaveLength(2);
  });

  it("잘못된 값을 막는다(제목·본문·분류·고정 규칙·종류)", async () => {
    const s = await shop();
    const cases: [unknown, string][] = [
      [{ kind: "x", title: "a", body: "b" }, "invalid_kind"],
      [{ kind: "notice", title: "", body: "b" }, "invalid_title"],
      [{ kind: "notice", title: "가".repeat(61), body: "b" }, "invalid_title"],
      [{ kind: "notice", title: "a", body: "" }, "invalid_body"],
      [{ kind: "faq", title: "a", body: "b", category: "가".repeat(21) }, "invalid_category"],
      [{ kind: "notice", title: "a", body: "b", category: "가".repeat(21) }, "invalid_category"],
      [{ kind: "faq", title: "a", body: "b", isPinned: true }, "invalid_pin"],
      [{ kind: "notice", title: "a", body: "b", isPinned: true, isPublished: false }, "invalid_pin"],
    ];
    for (const [body, error] of cases) {
      const r = await create(s.owner, body);
      expect([r.res.status, r.body]).toEqual([400, { error, message: NOTICE_MESSAGES[error as keyof typeof NOTICE_MESSAGES] }]);
    }
    expect((await create(s.owner, { kind: "notice", title: "a", body: "b", category: "배송" })).body.notice?.category).toBe("배송");
  });

  it("홈 띠 고정은 1개: 새로 고정하면 이전 고정이 풀리고, 비공개로 바꾸면 고정도 풀린다", async () => {
    const s = await shop();
    const a = (await create(s.owner, { kind: "notice", title: "A", body: "a", isPinned: true })).body.notice!;
    const b = (await create(s.owner, { kind: "notice", title: "B", body: "b", isPinned: true })).body.notice!;
    expect((await list(s.owner, "notice")).items.map((n) => [n.title, n.isPinned])).toEqual([["B", true], ["A", false]]);
    expect((await put(s.owner, a.id, { title: "A", body: "a", isPinned: true })).status).toBe(200);
    expect((await list(s.owner, "notice")).items.map((n) => [n.title, n.isPinned])).toEqual([["B", false], ["A", true]]);
    expect((await put(s.owner, a.id, { title: "A", body: "a", isPublished: false })).status).toBe(200);
    expect(await db.shopNotice.count({ where: { sellerId: s.seller.id, isPinned: true } })).toBe(0);
    expect(b.isPinned).toBe(true);
    // 동시에 고정해도 하나만 남는다
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push((await create(s.owner, { kind: "notice", title: `N${i}`, body: "x" })).body.notice!.id);
    const codes = await Promise.all(ids.map((id, i) => put(s.owner, id, { title: `N${i}`, body: "x", isPinned: true }).then((r) => r.status)));
    expect(codes).toEqual([200, 200, 200, 200, 200]);
    expect(await db.shopNotice.count({ where: { sellerId: s.seller.id, isPinned: true } })).toBe(1);
  });

  it("질문 순서 바꾸기, 목록이 다르면 409. 다른 쇼핑몰 글은 고치거나 지울 수 없다", async () => {
    const s = await shop();
    const t = await shop();
    const ids = [];
    for (const title of ["Q1", "Q2", "Q3"]) ids.push((await create(s.owner, { kind: "faq", title, body: "b" })).body.notice!.id);
    const res = await orderRoute(json("/api/seller/notices/faq-order", "PUT", s.staff, { ids: [ids[2], ids[0], ids[1]] }));
    expect(res.status).toBe(200);
    expect((await list(s.owner, "faq")).items.map((n) => n.title)).toEqual(["Q3", "Q1", "Q2"]);
    expect((await orderRoute(json("/api/seller/notices/faq-order", "PUT", s.owner, { ids: [ids[0], ids[1]] }))).status).toBe(409);
    expect((await orderRoute(json("/api/seller/notices/faq-order", "PUT", s.noPerm, { ids }))).status).toBe(403);
    expect((await put(t.owner, ids[0], { title: "해킹", body: "x" })).status).toBe(404);
    expect((await delRoute(json(`/api/seller/notices/${ids[0]}`, "DELETE", t.owner), p({ noticeId: ids[0] }))).status).toBe(404);
    expect((await list(t.owner, "faq")).items).toEqual([]);
    expect((await delRoute(json(`/api/seller/notices/${ids[0]}`, "DELETE", s.owner), p({ noticeId: ids[0] }))).status).toBe(200);
    expect((await list(s.owner, "faq")).items.map((n) => n.title)).toEqual(["Q3", "Q2"]);
    expect(await db.auditLog.count({ where: { sellerId: s.seller.id, action: { in: ["shop.faq.reorder", "shop.notice.delete"] } } })).toBe(2);
  });
});

describe("구매자 공지·질문 조회", () => {
  it("공개 공지만 최신순, 고정 공지는 따로, 상세·다음 쪽. 비공개·다른 쇼핑몰 공지는 404", async () => {
    const s = await shop();
    const t = await shop();
    const hidden = (await create(s.owner, { kind: "notice", title: "숨김", body: "x", isPublished: false })).body.notice!;
    const pinned = (await create(s.owner, { kind: "notice", title: "고정", body: "띠에 보여요", isPinned: true })).body.notice!;
    for (let i = 0; i < PUBLIC_PAGE_SIZE; i++) await create(s.owner, { kind: "notice", title: `공지${i}`, body: "x" });
    const r1 = await pubNotices(s.seller.slug);
    expect(r1.headers.get("cache-control")).toBe("public, max-age=30");
    const b1 = await r1.json();
    expect(b1.pinned).toEqual({ id: pinned.id, title: "고정", category: null, createdAt: expect.any(String) });
    expect(b1.notices).toHaveLength(PUBLIC_PAGE_SIZE);
    expect(b1.notices[0].title).toBe(`공지${PUBLIC_PAGE_SIZE - 1}`);
    const b2 = await (await pubNotices(s.seller.slug, `?cursor=${b1.nextCursor}`)).json();
    expect([b2.notices.map((n: { title: string }) => n.title), b2.nextCursor]).toEqual([["고정"], null]);
    const detail = await (await noticeRoute(get(`/api/shop/${s.seller.slug}/notices/${pinned.id}`), p({ slug: s.seller.slug, noticeId: pinned.id }))).json();
    expect(detail.notice).toMatchObject({ title: "고정", body: "띠에 보여요", isPinned: true });
    expect((await noticeRoute(get("/x"), p({ slug: s.seller.slug, noticeId: hidden.id }))).status).toBe(404);
    expect((await noticeRoute(get("/x"), p({ slug: t.seller.slug, noticeId: pinned.id }))).status).toBe(404);
    expect((await (await pubNotices(t.seller.slug)).json()).notices).toEqual([]);
  });

  it("공개 공지의 분류를 목록·상세에 싣고 비공개·미래 시각 초안은 숨긴다", async () => {
    const s = await shop();
    const created = await create(s.owner, { kind: "notice", title: "방송 공지", body: "방송 안내", category: "방송", isPinned: true });
    expect(created.res.status).toBe(201);
    const published = created.body.notice!;
    expect((await put(s.owner, published.id, { title: "방송 공지", body: "방송 안내", category: "이벤트", isPinned: true })).status).toBe(200);
    const draft = await db.shopNotice.create({
      data: { sellerId: s.seller.id, kind: "NOTICE", title: "초안", body: "미공개", category: "안내", isPublished: false },
    });
    const futureDraft = await db.shopNotice.create({
      data: {
        sellerId: s.seller.id,
        kind: "NOTICE",
        title: "미래 시각 초안",
        body: "예약 전 초안",
        category: "배송",
        isPublished: false,
        createdAt: new Date(Date.now() + 86_400_000),
      },
    });

    const listing = await (await pubNotices(s.seller.slug)).json();
    expect(listing.pinned).toMatchObject({ id: published.id, category: "이벤트" });
    expect(listing.notices).toContainEqual(expect.objectContaining({ id: published.id, category: "이벤트" }));
    expect(listing.notices.map((notice: { id: string }) => notice.id)).not.toContain(draft.id);
    expect(listing.notices.map((notice: { id: string }) => notice.id)).not.toContain(futureDraft.id);

    const detail = await (await noticeRoute(get(`/api/shop/${s.seller.slug}/notices/${published.id}`), p({ slug: s.seller.slug, noticeId: published.id }))).json();
    expect(detail.notice).toMatchObject({ id: published.id, category: "이벤트" });
    expect((await noticeRoute(get("/x"), p({ slug: s.seller.slug, noticeId: draft.id }))).status).toBe(404);
    expect((await noticeRoute(get("/x"), p({ slug: s.seller.slug, noticeId: futureDraft.id }))).status).toBe(404);
  });

  it("질문은 순서대로 본문까지, 분류 목록, 검색어로 좁힌다. 비공개는 빠진다", async () => {
    const s = await shop();
    await create(s.owner, { kind: "faq", title: "배송은 언제 와요?", body: "결제 다음 날 보내요", category: "배송" });
    await create(s.owner, { kind: "faq", title: "교환할 수 있나요?", body: "개봉 전이면 돼요", category: "교환·반품" });
    await create(s.owner, { kind: "faq", title: "비공개 질문", body: "배송", isPublished: false });
    const all = await (await pubFaqs(s.seller.slug)).json();
    expect(all.faqs.map((f: { title: string }) => f.title)).toEqual(["배송은 언제 와요?", "교환할 수 있나요?"]);
    expect(all.categories).toEqual(["배송", "교환·반품"]);
    expect(all.faqs[0]).toEqual({ id: expect.any(String), category: "배송", title: "배송은 언제 와요?", body: "결제 다음 날 보내요" });
    const found = await (await pubFaqs(s.seller.slug, `?q=${encodeURIComponent("개봉")}`)).json();
    expect(found.faqs.map((f: { title: string }) => f.title)).toEqual(["교환할 수 있나요?"]);
    // 한 글자 검색어는 무시(전체)
    expect((await (await pubFaqs(s.seller.slug, "?q=배")).json()).faqs).toHaveLength(2);
  });

  it("운영 중이 아닌 쇼핑몰은 404", async () => {
    const s = await shop();
    await create(s.owner, { kind: "notice", title: "A", body: "a" });
    await db.seller.update({ where: { id: s.seller.id }, data: { status: "SUSPENDED" } });
    expect((await pubNotices(s.seller.slug)).status).toBe(404);
    expect((await pubFaqs(s.seller.slug)).status).toBe(404);
    expect((await pubNotices("no-such-shop")).status).toBe(404);
  });
});
