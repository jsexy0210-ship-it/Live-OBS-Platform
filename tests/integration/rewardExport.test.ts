import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as balancesExport } from "../../app/api/seller/reward-balances/export/route";
import { GET as ledgerExport } from "../../app/api/seller/reward-ledger/export/route";
import { loginSeller } from "../../lib/server/auth/login";
import { REWARD_EXPORT_MAX, exportRewardBalances, exportRewardLedger } from "../../lib/server/rewards/export";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createBuyer, createPaidOrderItem, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 적립금 엑셀(CSV) 내려받기(SA-032·SA-033): 목록과 같은 값·조건, 수식 방어, 개인정보 최소, 판매자 격리, 권한, 로그 추적, 5,000줄 한도·여러 쪽 합치기.
beforeEach(resetDb);
afterAll(() => db.$disconnect());

let n = 0;
async function setup() {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const member = await createBuyer(seller.id, grade.id);
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, grade, owner, member, ctx };
}
type S = Awaited<ReturnType<typeof setup>>;
const lines = (csv: string) => csv.replace(/^﻿/, "").trimEnd().split("\r\n");
function row(s: S, d: { memberId?: string; type?: "EARN" | "REVOKE" | "ADJUST" | "USE"; amount: number; status?: "PENDING" | "SUCCEEDED" | "FAILED"; at: string; reason?: string; failureReason?: string; orderId?: string; key?: string }) {
  const at = new Date(d.at);
  return db.rewardLedger.create({
    data: {
      sellerId: s.seller.id,
      buyerMemberId: d.memberId ?? s.member.id,
      orderId: d.orderId ?? null,
      type: d.type ?? "EARN",
      amount: d.amount,
      status: d.status ?? "SUCCEEDED",
      testMode: false,
      reason: d.reason ?? null,
      failureReason: d.failureReason ?? null,
      idempotencyKey: d.key ?? `k${n++}`,
      createdAt: at,
      processedAt: (d.status ?? "SUCCEEDED") === "PENDING" ? null : at,
    },
  });
}

describe("적립금 CSV 내려받기", () => {
  it("원장: BOM·머리글·유형·사유 · 주문·부호 금액·잔액(후)·상태·실패 사유, 개인정보는 닉네임만, 수식 글자는 방어, 다른 쇼핑몰은 안 섞임", async () => {
    const s = await setup();
    await db.buyerMember.update({ where: { id: s.member.id }, data: { broadcastNickname: "=SUM(1)", name: "홍길동", phone: "01099998888" } });
    const { order } = await createPaidOrderItem(s.seller.id, s.member.id);
    await row(s, { amount: 1000, at: "2026-10-01T01:00:00Z", orderId: order.id, key: `earn:${order.id}` });
    await row(s, { type: "ADJUST", amount: -300, at: "2026-10-01T02:00:00Z", reason: "오지급, 정정" });
    await row(s, { type: "REVOKE", amount: -9000, status: "FAILED", at: "2026-10-01T03:00:00Z", failureReason: "insufficient_balance" });
    await row(s, { amount: 50, status: "PENDING", at: "2026-10-01T04:00:00Z" });
    const o = await setup();
    await row(o, { amount: 777, at: "2026-10-01T00:00:00Z" });

    const r = await exportRewardLedger(db, s.ctx, {});
    if (!r.ok) throw new Error("export");
    expect(r.csv.startsWith("﻿")).toBe(true);
    const l = lines(r.csv);
    expect(l[0]).toBe("회원,일시,유형,사유 · 주문,금액,잔액(후),상태,실패 사유");
    expect(l).toHaveLength(5);
    // 최신순: 대기 → 실패 → 수동 회수 → 배송 완료 적립
    expect(l[1]).toBe("'=SUM(1),2026.10.01 13:00,배송 완료 적립,,+50,,대기,");
    expect(l[2]).toBe("'=SUM(1),2026.10.01 12:00,회수,,-9000,,실패,잔액 부족");
    expect(l[3]).toBe(`'=SUM(1),2026.10.01 11:00,수동 회수,"오지급, 정정",-300,700,성공,`);
    expect(l[4]).toMatch(/^'=SUM\(1\),2026\.10\.01 10:00,배송 완료 적립,\d{8}-\d{4} · .+,\+1000,1000,성공,$/);
    expect(r.csv).not.toContain("홍길동");
    expect(r.csv).not.toContain("01099998888");
    expect(r.csv).not.toContain("777");
    expect(r.rows).toBe(4);
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "reward.ledger.export", sellerId: s.seller.id } })).toMatchObject({ after: { rows: 4, truncated: false } });
  });

  it("원장: 목록과 같은 조건(상태·유형·검색·기간·회원)으로 거르고 잘못된 값은 실패", async () => {
    const s = await setup();
    const m2 = await createBuyer(s.seller.id, s.grade.id);
    await db.buyerMember.update({ where: { id: m2.id }, data: { broadcastNickname: "별빛사냥꾼" } });
    await row(s, { amount: 100, at: "2026-09-01T00:00:00Z" });
    await row(s, { type: "ADJUST", amount: 20, at: "2026-10-02T00:00:00Z", reason: "보상" });
    await row(s, { amount: 30, at: "2026-10-03T00:00:00Z", memberId: m2.id });
    const rowsOf = async (q: Parameters<typeof exportRewardLedger>[2]) => {
      const r = await exportRewardLedger(db, s.ctx, q);
      return r.ok ? lines(r.csv).length - 1 : null;
    };
    expect(await rowsOf({})).toBe(3);
    expect(await rowsOf({ kind: "ADJUST_GRANT" })).toBe(1);
    expect(await rowsOf({ q: "별빛" })).toBe(1);
    expect(await rowsOf({ from: "2026-10-01", to: "2026-10-31" })).toBe(2);
    expect(await rowsOf({ memberId: m2.id })).toBe(1);
    expect(await rowsOf({ status: "FAILED" })).toBe(0);
    expect(await rowsOf({ kind: "NOPE" })).toBeNull();
    expect(await rowsOf({ status: "x" })).toBeNull();
  });

  it("원장: 200줄 쪽을 이어 붙여 최신순으로 주고(중복·빠짐 없음), 5,000줄을 넘으면 자르고 알린다", async () => {
    const s = await setup();
    await db.rewardLedger.createMany({
      data: Array.from({ length: REWARD_EXPORT_MAX + 3 }, (_, i) => ({ sellerId: s.seller.id, buyerMemberId: s.member.id, type: "EARN" as const, amount: i + 1, status: "SUCCEEDED" as const, testMode: false, idempotencyKey: `bulk${i}`, createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + i * 1000), processedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 0) + i * 1000) })),
    });
    const r = await exportRewardLedger(db, s.ctx, {});
    if (!r.ok) throw new Error("export");
    expect(r).toMatchObject({ rows: REWARD_EXPORT_MAX, truncated: true });
    const l = lines(r.csv);
    expect(l).toHaveLength(REWARD_EXPORT_MAX + 1);
    expect(l[1].split(",")[4]).toBe(`+${REWARD_EXPORT_MAX + 3}`); // 가장 최근 줄부터
    expect(new Set(l.slice(1).map((x) => x.split(",")[4])).size).toBe(REWARD_EXPORT_MAX); // 쪽 사이 중복·빠짐 없음
    expect(await db.auditLog.findFirstOrThrow({ where: { action: "reward.ledger.export" } })).toMatchObject({ after: { rows: REWARD_EXPORT_MAX, truncated: true } });
  }, 60_000);

  it("잔액: 열·값이 목록과 같고 q로 거르며, 다른 쇼핑몰·탈퇴 회원은 빠진다", async () => {
    const s = await setup();
    const m2 = await createBuyer(s.seller.id, s.grade.id);
    await db.buyerMember.update({ where: { id: m2.id }, data: { broadcastNickname: "별빛사냥꾼" } });
    const gone = await createBuyer(s.seller.id, s.grade.id);
    await db.buyerMember.update({ where: { id: gone.id }, data: { deletedAt: new Date(), status: "WITHDRAWN" } });
    await row(s, { amount: 1000, at: "2026-10-01T00:00:00Z" });
    await row(s, { type: "USE", amount: -200, at: "2026-10-01T01:00:00Z" });
    await row(s, { type: "ADJUST", amount: 50, at: "2026-10-01T02:00:00Z", reason: "보상" });
    await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: s.member.id, balance: 850 } });
    await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: m2.id, balance: 5 } });
    await db.rewardBalance.create({ data: { sellerId: s.seller.id, buyerMemberId: gone.id, balance: 99 } });
    const o = await setup();
    await db.rewardBalance.create({ data: { sellerId: o.seller.id, buyerMemberId: o.member.id, balance: 12345 } });
    const r = await exportRewardBalances(db, s.ctx, {});
    if (!r.ok) throw new Error("export");
    const l = lines(r.csv);
    expect(l[0]).toBe("회원,잔액,누적 지급,누적 사용,누적 회수,소멸,수동 조정,마지막 변동");
    expect(l).toHaveLength(3);
    expect(l.some((x) => x.includes("12345") || x.includes(",99,"))).toBe(false);
    const mine = l.find((x) => x.includes(",850,"))!;
    expect(mine.split(",").slice(1, 7)).toEqual(["850", "1000", "200", "0", "0", "+50"]);
    const q = await exportRewardBalances(db, s.ctx, { q: "별빛" });
    expect(q.ok && lines(q.csv).length).toBe(2);
    expect(await db.auditLog.count({ where: { action: "reward.balances.export", sellerId: s.seller.id } })).toBe(2);
    expect(await exportRewardBalances(db, s.ctx, { q: "x".repeat(51) })).toEqual({ ok: false });
  });

  it("권한 없는 직원은 내려받을 수 없고, 다운로드 응답은 CSV 머리글·파일 이름을 가진다", async () => {
    const s = await setup();
    const staff: TenantContext = { ...s.ctx, isOwner: false, permissions: [] };
    await expect(exportRewardLedger(db, staff, {})).rejects.toMatchObject({ status: 403 });
    await expect(exportRewardBalances(db, staff, {})).rejects.toMatchObject({ status: 403 });
    const login = await loginSeller(db, { email: s.owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const headers = { host: "localhost:3000", cookie: `lo_seller=${login.token}` };
    for (const [route, path, file] of [
      [ledgerExport, "reward-ledger", "reward-ledger-"],
      [balancesExport, "reward-balances", "reward-balances-"],
    ] as const) {
      const res = await route(new Request(`http://localhost:3000/api/seller/${path}/export`, { headers }));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(res.headers.get("content-disposition")).toMatch(new RegExp(`^attachment; filename="${file}\\d{8}\\.csv"$`));
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect((await res.text()).startsWith("﻿")).toBe(true);
    }
    const bad = await ledgerExport(new Request("http://localhost:3000/api/seller/reward-ledger/export?kind=NOPE", { headers }));
    expect(bad.status).toBe(400);
    const noAuth = await ledgerExport(new Request("http://localhost:3000/api/seller/reward-ledger/export", { headers: { host: "localhost:3000" } }));
    expect(noAuth.status).toBe(401);
  });
});
