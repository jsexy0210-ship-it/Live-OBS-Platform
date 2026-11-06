import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as highlightsRoute } from "../../app/api/shop/[slug]/home/highlights/route";
import { prisma } from "../../lib/server/db";
import { HOME_HIT_ROWS, shopHomeHighlights } from "../../lib/server/shop/highlights";
import { createSeller, db, resetDb } from "./helpers";

// SH-001 홈 공개 데이터: 이번 주 인기 카드(최근 7일 HIT 최신순 5장·닉네임 정리·다른 쇼핑몰 제외), 히어로 카드(혜택·HIT·공지).
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const NOW = new Date("2026-10-20T03:00:00Z");
const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs);
const get = (slug: string) => highlightsRoute(new Request(`http://localhost:3000/api/shop/${slug}/home/highlights`), { params: Promise.resolve({ slug }) });

describe("쇼핑몰 홈 공개 데이터", () => {
  it("최근 7일 HIT 카드를 최신순 5장, 순위·정리된 닉네임으로 주고 7일이 지난 카드·다른 쇼핑몰 카드는 뺀다. weekCount는 5장 제한과 상관없이 센다", async () => {
    const { seller } = await createSeller();
    const other = (await createSeller()).seller;
    const card = (sellerId: string, cardName: string, at: Date, nick = "닉", grade: string | null = null) => db.hitCard.create({ data: { sellerId, cardName, nicknameSnapshot: nick, grade, createdAt: at } });
    await card(seller.id, "오래된 카드", ago(7, 1000)); // 7일 + 1초 전 — 제외
    for (let i = 0; i < 6; i++) await card(seller.id, `카드${i}`, ago(i, 60_000), i === 0 ? "  별빛\t사냥꾼\n" : `닉${i}`, i === 0 ? "SAR" : null);
    await card(other.id, "남의 카드", ago(1));
    const r = (await shopHomeHighlights(db, seller.slug, NOW))!;
    expect(r.weeklyHits.map((h) => [h.rank, h.nickname, h.cardName, h.grade])).toEqual([
      [1, "별빛 사냥꾼", "카드0", "SAR"],
      [2, "닉1", "카드1", null],
      [3, "닉2", "카드2", null],
      [4, "닉3", "카드3", null],
      [5, "닉4", "카드4", null],
    ]);
    expect(r.weeklyHits).toHaveLength(HOME_HIT_ROWS);
    expect(r.hero.hit.weekCount).toBe(6);
    expect(Object.keys(r.weeklyHits[0]).sort()).toEqual(["cardName", "createdAt", "grade", "nickname", "rank"]); // 구매자·주문 정보는 없다
    expect((await shopHomeHighlights(db, other.slug, NOW))!.weeklyHits.map((h) => h.cardName)).toEqual(["남의 카드"]);
  });

  it("혜택 카드: 등급별 적립률(카드·무통장) 중 가장 큰 값, 등급 자동 갱신이 켜졌을 때만 주기·다음 시각. 설정이 없으면 null", async () => {
    const { seller, grade } = await createSeller();
    expect((await shopHomeHighlights(db, seller.slug, NOW))!.hero.benefit).toEqual({ maxRewardRate: null, gradeRefresh: null });
    const vip = await db.memberGrade.create({ data: { sellerId: seller.id, displayName: "VIP", sortOrder: 4, systemKey: "VIP" } });
    const gone = "00000000-0000-4000-8000-000000000000"; // 지금 없는 등급의 적립률은 세지 않는다
    await db.rewardPolicy.create({ data: { sellerId: seller.id, rates: { [grade.id]: { card: 1, bankTransfer: 2 }, [vip.id]: { card: 5, bankTransfer: 3 }, [gone]: { card: 99 } } } });
    await db.memberGradePolicy.create({ data: { sellerId: seller.id, autoEnabled: true, cadence: "MONTHLY" } });
    const b = (await shopHomeHighlights(db, seller.slug, NOW))!.hero.benefit;
    expect(b.maxRewardRate).toBe(5);
    expect(b.gradeRefresh).toEqual({ cadence: "MONTHLY", nextRunAt: new Date("2026-10-31T15:00:00.000Z") }); // KST 11/1 0시
    await db.memberGradePolicy.update({ where: { sellerId: seller.id }, data: { autoEnabled: false } });
    expect((await shopHomeHighlights(db, seller.slug, NOW))!.hero.benefit.gradeRefresh).toBeNull();
  });

  it("공지 카드: 고정 공지가 있으면 그것, 없으면 가장 최근 공개 공지, 비공개·글(FAQ 등)은 제외, 없으면 null", async () => {
    const { seller } = await createSeller();
    const notice = (title: string, at: Date, o: { isPinned?: boolean; isPublished?: boolean; kind?: "NOTICE" | "FAQ" } = {}) =>
      db.shopNotice.create({ data: { sellerId: seller.id, kind: o.kind ?? "NOTICE", title, body: "본문", isPinned: o.isPinned ?? false, isPublished: o.isPublished ?? true, createdAt: at } });
    expect((await shopHomeHighlights(db, seller.slug, NOW))!.hero.notice).toBeNull();
    await notice("옛 공지", ago(5));
    await notice("최근 비공개", ago(1), { isPublished: false });
    await notice("최근 FAQ", ago(0), { kind: "FAQ" });
    expect((await shopHomeHighlights(db, seller.slug, NOW))!.hero.notice?.title).toBe("옛 공지");
    await notice("새 공지", ago(2));
    expect((await shopHomeHighlights(db, seller.slug, NOW))!.hero.notice?.title).toBe("새 공지");
    await notice("고정 공지", ago(30), { isPinned: true });
    const n = (await shopHomeHighlights(db, seller.slug, NOW))!.hero.notice;
    expect([n?.title, n?.isPinned]).toEqual(["고정 공지", true]);
  });

  it("API: 로그인 없이 200과 캐시 머리, 없는 주소·운영 중이 아닌 쇼핑몰은 404", async () => {
    const { seller } = await createSeller();
    await db.hitCard.create({ data: { sellerId: seller.id, cardName: "방금 카드", nicknameSnapshot: "닉" } });
    const ok = await get(seller.slug);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("public, max-age=30");
    expect((await ok.json()).weeklyHits.map((h: { cardName: string }) => h.cardName)).toEqual(["방금 카드"]);
    expect((await get("no-such-shop")).status).toBe(404);
    await db.seller.update({ where: { id: seller.id }, data: { operatingState: "PAUSED" } });
    expect((await get(seller.slug)).status).toBe(404);
  });
});
