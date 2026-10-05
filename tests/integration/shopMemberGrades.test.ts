import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { GET as gradesGet, POST as gradesPost, PUT as gradesPut } from "../../app/api/seller/member-grades/route";
import { loginSeller } from "../../lib/server/auth/login";
import { prisma } from "../../lib/server/db";
import { withdrawBuyer } from "../../lib/server/buyers/withdraw";
import { SCHEDULED_JOBS } from "../../lib/server/jobs/scheduler";
import { addMemberGrade, deleteMemberGrade, getMemberGrades, recalcMonthlyGrades, recalcNow, recalcSellerGrades, saveMemberGrades, setMemberGrade } from "../../lib/server/shop-member-grades/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { PASSWORD, createBuyer, createLoginBuyer, createSeller, createSellerUser, db, resetDb } from "./helpers";

// 회원 등급(SA-044): 이름·기준액 저장 검사, 등급 추가·삭제, 월 1회 자동 재산정(승급 한 번에·강등 한 단계씩·기간·고정·상태 제외·동시 실행), 직접 조정, 권한·판매자 격리, 탈퇴.
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const H = { host: "localhost:3000", origin: "http://localhost:3000", "content-type": "application/json" };
const NOW = new Date("2026-11-01T00:30:00+09:00"); // 11월 1일(KST)
const DAY = 86_400_000;

// 등급: 일반(0) · 새싹(100,000) · 실버(500,000) · 골드(1,000,000)
async function shop(auto = true) {
  const { seller, grade } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  const ids = [grade.id];
  for (const [name, amount] of [["새싹", 100_000], ["실버", 500_000], ["골드", 1_000_000]] as const) {
    const r = await addMemberGrade(db, ctx, { displayName: name, minAmount: amount });
    if (!r.ok) throw new Error(r.reason);
    ids.push(r.id);
  }
  await db.memberGrade.update({ where: { id: grade.id }, data: { systemKey: "BASIC" } });
  if (auto) await db.memberGradePolicy.update({ where: { sellerId: seller.id }, data: { autoEnabled: true } });
  const member = async (gradeIndex: number, status: "ACTIVE" | "DORMANT" = "ACTIVE") => {
    const m = await createBuyer(seller.id, ids[gradeIndex]);
    if (status !== "ACTIVE") await db.buyerMember.update({ where: { id: m.id }, data: { status } });
    return m;
  };
  const paid = (memberId: string, amount: number, ago = DAY, status: "PAID" | "REFUNDED" | "CANCELLED" = "PAID") =>
    db.order.create({
      data: { sellerId: seller.id, orderNo: Math.floor(Math.random() * 1e9), buyerMemberId: memberId, status, broadcastNicknameSnapshot: "닉", totalAmount: amount, paidAt: new Date(NOW.getTime() - ago) },
    });
  const gradeOf = async (memberId: string) => (await db.buyerMember.findUniqueOrThrow({ where: { id: memberId }, include: { grade: true } })).grade.displayName;
  return { seller, owner, ctx, ids, member, paid, gradeOf };
}

describe("저장·추가·삭제 검사", () => {
  it("이름·기준액을 저장하고, 잘못된 입력은 아무것도 바꾸지 않는다", async () => {
    const s = await shop();
    const edit = (i: number, displayName: string, minAmount: number) => ({ id: s.ids[i], displayName, minAmount });
    expect(await saveMemberGrades(db, s.ctx, { grades: [edit(1, "씨앗", 200_000)] })).toEqual({ ok: true });
    expect(await db.memberGrade.findUniqueOrThrow({ where: { id: s.ids[1] } })).toMatchObject({ displayName: "씨앗", minAmount: 200_000 });
    const bad = async (body: Parameters<typeof saveMemberGrades>[2]) => (await saveMemberGrades(db, s.ctx, body) as { reason: string }).reason;
    expect(await bad({ grades: [edit(1, "  ", 1)] })).toBe("invalid_grade_name");
    expect(await bad({ grades: [edit(1, "가".repeat(13), 1)] })).toBe("invalid_grade_name");
    expect(await bad({ grades: [{ id: s.ids[1], displayName: "x", minAmount: -1 }] })).toBe("invalid_min_amount");
    expect(await bad({ grades: [{ id: s.ids[1], displayName: "x", minAmount: 1.5 }] })).toBe("invalid_min_amount");
    expect(await bad({ grades: [edit(2, "씨앗", 500_000)] })).toBe("duplicate_name");
    expect(await bad({ grades: [edit(0, "일반", 10)] })).toBe("base_grade_amount");
    expect(await bad({ grades: [edit(2, "실버", 100_000)] })).toBe("invalid_thresholds"); // 자동 재산정이 켜져 있어 순서대로 커야 함
    expect(await bad({ grades: [{ id: "00000000-0000-4000-8000-000000000000", displayName: "x", minAmount: 1 }] })).toBe("not_found");
    expect(await bad({ grades: [{ id: "bad", displayName: "x", minAmount: 1 }] })).toBe("invalid_body");
    expect(await bad({ autoEnabled: "yes" })).toBe("invalid_body");
    // 실패한 요청은 이름·기준액을 하나도 바꾸지 않았다
    expect((await db.memberGrade.findMany({ where: { sellerId: s.seller.id }, orderBy: { sortOrder: "asc" } })).map((g) => [g.displayName, g.minAmount])).toEqual([["일반", 0], ["씨앗", 200_000], ["실버", 500_000], ["골드", 1_000_000]]);
  });

  it("두 등급의 이름을 서로 맞바꿀 수 있고, 자동 재산정이 꺼져 있으면 기준액 순서를 강제하지 않는다", async () => {
    const s = await shop(false);
    expect(await saveMemberGrades(db, s.ctx, { grades: [{ id: s.ids[1], displayName: "실버", minAmount: 100_000 }, { id: s.ids[2], displayName: "새싹", minAmount: 50_000 }] })).toEqual({ ok: true });
    expect((await db.memberGrade.findMany({ where: { sellerId: s.seller.id, id: { in: [s.ids[1], s.ids[2]] } }, orderBy: { sortOrder: "asc" } })).map((g) => g.displayName)).toEqual(["실버", "새싹"]);
    // 켜려고 하면 순서가 맞아야 한다
    expect(await saveMemberGrades(db, s.ctx, { autoEnabled: true })).toEqual({ ok: false, reason: "invalid_thresholds" });
    expect((await db.memberGradePolicy.findUniqueOrThrow({ where: { sellerId: s.seller.id } })).autoEnabled).toBe(false);
    expect(await saveMemberGrades(db, s.ctx, { grades: [{ id: s.ids[2], displayName: "새싹", minAmount: 300_000 }] })).toEqual({ ok: true });
    expect(await saveMemberGrades(db, s.ctx, { autoEnabled: true })).toEqual({ ok: true });
  });

  it("등급은 10개까지, 이름 중복은 막고, 삭제하면 회원은 기본 등급으로 옮기며 기본 등급은 지울 수 없다", async () => {
    const s = await shop();
    expect(await addMemberGrade(db, s.ctx, { displayName: "골드", minAmount: 9_000_000 })).toEqual({ ok: false, reason: "duplicate_name" });
    expect(await addMemberGrade(db, s.ctx, { displayName: "낮음", minAmount: 1_000_000 })).toEqual({ ok: false, reason: "invalid_thresholds" });
    for (let i = 0; i < 6; i++) expect(await addMemberGrade(db, s.ctx, { displayName: `상위${i}`, minAmount: 2_000_000 + i })).toMatchObject({ ok: true });
    expect(await addMemberGrade(db, s.ctx, { displayName: "열한째", minAmount: 9_000_000 })).toEqual({ ok: false, reason: "too_many_grades" });
    const custom = await db.memberGrade.findFirstOrThrow({ where: { sellerId: s.seller.id, displayName: "상위0" } });
    const m = await s.member(0);
    await db.buyerMember.update({ where: { id: m.id }, data: { gradeId: custom.id } });
    // 회원이 있어도 지울 수 있다: 회원은 기본 등급으로 옮기고 변경 기록(GRADE_REMOVED)을 남긴다
    expect(await deleteMemberGrade(db, s.ctx, custom.id)).toEqual({ ok: true, moved: 1 });
    expect(await s.gradeOf(m.id)).toBe("일반");
    expect(await db.memberGradeHistory.findFirstOrThrow({ where: { buyerMemberId: m.id } })).toMatchObject({ fromName: "상위0", toName: "일반", reason: "GRADE_REMOVED" });
    expect(await db.memberGrade.count({ where: { id: custom.id } })).toBe(0);
    expect(await deleteMemberGrade(db, s.ctx, s.ids[0])).toEqual({ ok: false, reason: "base_grade_fixed" });
    expect(await deleteMemberGrade(db, s.ctx, "nope")).toEqual({ ok: false, reason: "not_found" });
    const other = await shop();
    expect(await deleteMemberGrade(db, other.ctx, s.ids[3])).toEqual({ ok: false, reason: "not_found" });
  });

  it("권한 없는 직원·읽기 전용은 보지도 바꾸지도 못하고, 다른 쇼핑몰 등급은 건드릴 수 없다", async () => {
    const s = await shop();
    const staff = await createSellerUser(s.seller.id, { permissions: ["PRODUCT_MANAGE"] });
    const sctx: TenantContext = { ...s.ctx, actorId: staff.id, isOwner: false, permissions: ["PRODUCT_MANAGE"] };
    await expect(getMemberGrades(db, sctx)).rejects.toThrow();
    await expect(saveMemberGrades(db, sctx, { autoEnabled: false })).rejects.toThrow();
    await expect(addMemberGrade(db, sctx, { displayName: "x", minAmount: 1 })).rejects.toThrow();
    await expect(saveMemberGrades(db, { ...s.ctx, readOnly: true }, { autoEnabled: false })).rejects.toThrow();
    const pointsStaff: TenantContext = { ...s.ctx, actorId: staff.id, isOwner: false, permissions: ["MEMBER_POINTS"] };
    expect(await getMemberGrades(db, pointsStaff)).toMatchObject({ autoEnabled: true });
    const other = await shop();
    expect(await saveMemberGrades(db, other.ctx, { grades: [{ id: s.ids[1], displayName: "탈취", minAmount: 1 }] })).toEqual({ ok: false, reason: "not_found" });
    expect((await db.memberGrade.findUniqueOrThrow({ where: { id: s.ids[1] } })).displayName).toBe("새싹");
  });

  it("라우트: 대표자는 조회·저장·추가하고, 로그인하지 않으면 401", async () => {
    const s = await shop();
    const login = await loginSeller(db, { email: s.owner.email, password: PASSWORD }, {});
    if (!login.ok) throw new Error(login.reason);
    const headers = { ...H, cookie: `lo_seller=${login.token}` };
    const get = await gradesGet(new Request("http://localhost:3000/api/seller/member-grades", { headers }));
    expect(get.status).toBe(200);
    expect(await get.json()).toMatchObject({ autoEnabled: true, grades: [{ displayName: "일반", isBase: true, minAmount: 0 }, { displayName: "새싹" }, { displayName: "실버" }, { displayName: "골드" }] });
    const put = await gradesPut(new Request("http://localhost:3000/x", { method: "PUT", headers, body: JSON.stringify({ grades: [{ id: s.ids[1], displayName: "새싹", minAmount: -5 }] }) }));
    expect(put.status).toBe(400);
    expect(await put.json()).toMatchObject({ error: "invalid_min_amount", message: expect.stringContaining("0원 이상") });
    const post = await gradesPost(new Request("http://localhost:3000/x", { method: "POST", headers, body: JSON.stringify({ displayName: "다이아", minAmount: 5_000_000 }) }));
    expect(post.status).toBe(201);
    expect((await gradesGet(new Request("http://localhost:3000/api/seller/member-grades", { headers: H }))).status).toBe(401);
  });
});

describe("월 1회 자동 재산정", () => {
  it("승급은 목표 등급까지 한 번에, 강등은 한 단계씩이고, 기준 기간·결제 상태를 지킨다", async () => {
    const s = await shop();
    const up = await s.member(0); // 일반 → 최근 6개월 120만원 → 골드
    await s.paid(up.id, 700_000, 30 * DAY);
    await s.paid(up.id, 500_000, 150 * DAY);
    const old = await s.member(0); // 7개월 전 주문은 기간 밖 → 일반
    await s.paid(old.id, 2_000_000, 215 * DAY);
    const down = await s.member(3); // 골드 → 구매 없음 → 실버(한 단계)
    const edge = await s.member(1); // 새싹 → 정확히 100,000원 → 그대로
    await s.paid(edge.id, 100_000);
    const refunded = await s.member(0); // 환불·취소 주문은 세지 않음
    await s.paid(refunded.id, 900_000, DAY, "REFUNDED");
    await s.paid(refunded.id, 900_000, DAY, "CANCELLED");
    const dormant = await s.member(3, "DORMANT"); // 정상 회원이 아니면 건너뜀
    const r = await recalcSellerGrades(db, s.seller.id, NOW);
    expect(r).toEqual({ ran: true, promoted: 1, demoted: 1, unchanged: 3 });
    expect(await s.gradeOf(up.id)).toBe("골드");
    expect(await s.gradeOf(old.id)).toBe("일반");
    expect(await s.gradeOf(down.id)).toBe("실버");
    expect(await s.gradeOf(edge.id)).toBe("새싹");
    expect(await s.gradeOf(refunded.id)).toBe("일반");
    expect(await s.gradeOf(dormant.id)).toBe("골드");
    const hist = await db.memberGradeHistory.findMany({ where: { sellerId: s.seller.id }, orderBy: { reason: "asc" } });
    expect(hist.map((h) => [h.fromName, h.toName, h.reason, h.amount]).sort()).toEqual([["골드", "실버", "AUTO_DOWN", 0], ["일반", "골드", "AUTO_UP", 1_200_000]]);
    expect(await db.memberGradeRun.findUniqueOrThrow({ where: { sellerId_monthKey: { sellerId: s.seller.id, monthKey: "2026-11" } } })).toMatchObject({ promoted: 1, demoted: 1 });
    expect(await db.auditLog.count({ where: { action: "member_grade.recalc", targetId: s.seller.id } })).toBe(1);
  });

  it("부분 환불한 금액은 결제액에서 빼고 센다(환불 뒤 남은 금액으로 승급 판정)", async () => {
    const s = await shop();
    const m = await s.member(0);
    const o = await s.paid(m.id, 600_000); // 새싹(100,000)·실버(500,000) 기준 위
    await db.order.update({ where: { id: o.id }, data: { refundAmount: 450_000 } }); // 남은 150,000원 → 새싹
    await recalcSellerGrades(db, s.seller.id, NOW);
    expect(await s.gradeOf(m.id)).toBe("새싹");
    const hist = await db.memberGradeHistory.findFirstOrThrow({ where: { buyerMemberId: m.id } });
    expect(hist.amount).toBe(150_000);
  });

  it("같은 달에는 다시 돌지 않고(동시 실행 포함) 다음 달에는 한 단계 더 내린다", async () => {
    const s = await shop();
    const down = await s.member(3);
    const runs = await Promise.all([1, 2, 3].map(() => recalcSellerGrades(db, s.seller.id, NOW)));
    expect(runs.filter((r) => r.ran)).toHaveLength(1);
    expect(await s.gradeOf(down.id)).toBe("실버");
    expect(await recalcSellerGrades(db, s.seller.id, new Date(NOW.getTime() + 3600_000))).toMatchObject({ ran: false, promoted: 0, demoted: 0 });
    expect(await s.gradeOf(down.id)).toBe("실버");
    const dec = new Date("2026-12-01T00:10:00+09:00");
    expect(await recalcSellerGrades(db, s.seller.id, dec)).toMatchObject({ ran: true, demoted: 1 });
    expect(await s.gradeOf(down.id)).toBe("새싹");
  });

  it("꺼져 있거나 기준액이 올바르지 않은 쇼핑몰은 돌지 않고, 정기 작업은 이 달에 돌지 않은 쇼핑몰만 처리한다", async () => {
    const off = await shop(false);
    const m = await off.member(3);
    expect(await recalcSellerGrades(db, off.seller.id, NOW)).toMatchObject({ ran: false, promoted: 0, demoted: 0 });
    expect(await off.gradeOf(m.id)).toBe("골드");
    const broken = await shop();
    await db.memberGrade.update({ where: { id: broken.ids[2] }, data: { minAmount: 50_000 } }); // 새싹(100,000)보다 낮음
    const bm = await broken.member(3);
    expect(await recalcSellerGrades(db, broken.seller.id, NOW)).toMatchObject({ ran: false, promoted: 0, demoted: 0 });
    expect(await broken.gradeOf(bm.id)).toBe("골드");
    expect(await db.memberGradeRun.count({ where: { sellerId: broken.seller.id } })).toBe(0);
    const ok = await shop();
    const om = await ok.member(3);
    expect(await recalcMonthlyGrades(db, NOW)).toBe(1);
    expect(await ok.gradeOf(om.id)).toBe("실버");
    expect(await recalcMonthlyGrades(db, NOW)).toBe(0);
    expect(SCHEDULED_JOBS.map((j) => j.name)).toContain("member_grade.recalc_monthly");
  });

  it("다른 쇼핑몰 회원은 건드리지 않는다", async () => {
    const a = await shop();
    const b = await shop(false);
    const bm = await b.member(3);
    await a.member(3);
    await recalcSellerGrades(db, a.seller.id, NOW);
    expect(await b.gradeOf(bm.id)).toBe("골드");
    expect(await db.memberGradeHistory.count({ where: { sellerId: b.seller.id } })).toBe(0);
  });
});

describe("직접 조정", () => {
  it("고정한 회원은 자동 재산정에서 빠지고, 고정을 풀면 다시 대상이 된다", async () => {
    const s = await shop();
    const m = await s.member(0);
    expect(await setMemberGrade(db, s.ctx, m.id, { gradeId: s.ids[3], lock: true })).toEqual({ ok: true, changed: true });
    expect(await s.gradeOf(m.id)).toBe("골드");
    expect(await getMemberGrades(db, s.ctx)).toMatchObject({ lockedCount: 1, locked: [{ memberId: m.id }] });
    await recalcSellerGrades(db, s.seller.id, NOW);
    expect(await s.gradeOf(m.id)).toBe("골드");
    // 고정만 풀기(등급은 그대로)
    expect(await setMemberGrade(db, s.ctx, m.id, { gradeId: s.ids[3], lock: false })).toEqual({ ok: true, changed: false });
    expect(await db.memberGradeOverride.count()).toBe(0);
    await recalcSellerGrades(db, s.seller.id, new Date("2026-12-01T00:10:00+09:00"));
    expect(await s.gradeOf(m.id)).toBe("실버");
    expect((await db.memberGradeHistory.findMany({ where: { buyerMemberId: m.id }, orderBy: { createdAt: "asc" } })).map((h) => h.reason)).toEqual(["MANUAL", "AUTO_DOWN"]);
    expect(await db.auditLog.count({ where: { action: "member_grade.manual", targetId: m.id } })).toBe(2);
  });

  it("정상 회원만, 같은 쇼핑몰의 회원·등급만 조정할 수 있다", async () => {
    const s = await shop();
    const dormant = await s.member(0, "DORMANT");
    expect(await setMemberGrade(db, s.ctx, dormant.id, { gradeId: s.ids[1], lock: false })).toEqual({ ok: false, reason: "member_not_active" });
    const other = await shop();
    const om = await other.member(0);
    const m = await s.member(0);
    expect(await setMemberGrade(db, s.ctx, om.id, { gradeId: s.ids[1], lock: false })).toEqual({ ok: false, reason: "not_found" });
    expect(await setMemberGrade(db, s.ctx, m.id, { gradeId: other.ids[1], lock: false })).toEqual({ ok: false, reason: "not_found" });
    expect(await setMemberGrade(db, s.ctx, m.id, { gradeId: "x", lock: false })).toEqual({ ok: false, reason: "invalid_body" });
    expect(await setMemberGrade(db, s.ctx, m.id, { gradeId: s.ids[1] })).toEqual({ ok: false, reason: "invalid_body" });
    const staff = await createSellerUser(s.seller.id, { permissions: ["ORDER_SHIPPING"] });
    await expect(setMemberGrade(db, { ...s.ctx, actorId: staff.id, isOwner: false, permissions: ["ORDER_SHIPPING"] }, m.id, { gradeId: s.ids[1], lock: false })).rejects.toThrow();
    expect(await s.gradeOf(m.id)).toBe("일반");
  });
});

describe("탈퇴", () => {
  it("고정 표시와 등급 변경 기록을 지운다", async () => {
    const s = await shop();
    const buyer = await createLoginBuyer(s.seller.id, s.ids[0]);
    await setMemberGrade(db, s.ctx, buyer.id, { gradeId: s.ids[2], lock: true });
    expect(await db.memberGradeOverride.count({ where: { buyerMemberId: buyer.id } })).toBe(1);
    expect(await withdrawBuyer(db, { sellerId: s.seller.id, buyerMemberId: buyer.id }, { password: PASSWORD })).toEqual({ ok: true });
    expect(await db.memberGradeOverride.count({ where: { buyerMemberId: buyer.id } })).toBe(0);
    expect(await db.memberGradeHistory.count({ where: { buyerMemberId: buyer.id } })).toBe(0);
  });
});

describe("산정 기준·지금 재산정·고정 기간 (v2)", () => {
  it("기간 설정(3·12개월·누적)에 따라 센다", async () => {
    const s = await shop();
    const m3 = await s.member(0);
    await s.paid(m3.id, 700_000, 150 * DAY); // 5개월 전
    const m12 = await s.member(0);
    await s.paid(m12.id, 700_000, 300 * DAY); // 10개월 전
    const all = await s.member(0);
    await s.paid(all.id, 700_000, 900 * DAY); // 30개월 전
    await saveMemberGrades(db, s.ctx, { windowMonths: 3 });
    expect(await recalcNow(db, s.ctx, NOW)).toMatchObject({ ok: true, promoted: 0 });
    await saveMemberGrades(db, s.ctx, { windowMonths: 12 });
    expect(await recalcNow(db, s.ctx, NOW)).toMatchObject({ ok: true, promoted: 2 }); // 5개월·10개월 전 주문
    expect(await s.gradeOf(m3.id)).toBe("실버");
    expect(await s.gradeOf(m12.id)).toBe("실버");
    expect(await s.gradeOf(all.id)).toBe("일반");
    await saveMemberGrades(db, s.ctx, { windowMonths: 0 });
    expect(await recalcNow(db, s.ctx, NOW)).toMatchObject({ ok: true, promoted: 1 });
    expect(await s.gradeOf(all.id)).toBe("실버");
    expect(await saveMemberGrades(db, s.ctx, { windowMonths: 5 })).toEqual({ ok: false, reason: "invalid_setting" });
    expect(await saveMemberGrades(db, s.ctx, { cadence: "HOURLY" })).toEqual({ ok: false, reason: "invalid_setting" });
    expect(await saveMemberGrades(db, s.ctx, { demotion: "FAST" })).toEqual({ ok: false, reason: "invalid_setting" });
  });

  it("강등 방식: 바로는 목표 등급까지, 없음은 내리지 않는다", async () => {
    const s = await shop();
    const a = await s.member(3);
    await saveMemberGrades(db, s.ctx, { demotion: "IMMEDIATE" });
    await recalcNow(db, s.ctx, NOW);
    expect(await s.gradeOf(a.id)).toBe("일반");
    const b = await s.member(3);
    await saveMemberGrades(db, s.ctx, { demotion: "NONE" });
    expect(await recalcNow(db, s.ctx, NOW)).toMatchObject({ demoted: 0 });
    expect(await s.gradeOf(b.id)).toBe("골드");
    const up = await s.member(0);
    await s.paid(up.id, 600_000);
    await recalcNow(db, s.ctx, NOW);
    expect(await s.gradeOf(up.id)).toBe("실버"); // 없음이어도 승급은 한다
  });

  it("주기: 켜거나 주기를 바꾸면 그 주기를 이미 돈 것으로 기록해 바로 돌지 않고, 다음 주기에 돈다(월·주·일 키)", async () => {
    const s = await shop(false);
    const m = await s.member(3);
    await saveMemberGrades(db, s.ctx, { autoEnabled: true, cadence: "WEEKLY" });
    const wk = await db.memberGradeRun.findMany({ where: { sellerId: s.seller.id } });
    expect(wk).toHaveLength(1);
    expect(wk[0].monthKey).toMatch(/^\d{4}-W\d{2}$/);
    // 저장 직후 정기 작업은 아무것도 하지 않는다
    expect(await recalcMonthlyGrades(db, new Date())).toBe(0);
    expect(await s.gradeOf(m.id)).toBe("골드");
    // 다음 주에는 돈다(그 주 월요일 0시 이후)
    const nextWeek = new Date(Date.now() + 8 * DAY);
    expect(await recalcMonthlyGrades(db, nextWeek)).toBe(1);
    expect(await s.gradeOf(m.id)).toBe("실버");
    expect(await recalcMonthlyGrades(db, nextWeek)).toBe(0);
    // 일 단위로 바꾸면 그날은 기록만 하고, 다음 날 돈다
    await saveMemberGrades(db, s.ctx, { cadence: "DAILY" });
    expect(await recalcMonthlyGrades(db, new Date())).toBe(0); // 바꾼 날은 기록만 했으니 돌지 않는다
    expect(await recalcMonthlyGrades(db, new Date(nextWeek.getTime() + DAY))).toBe(1);
    expect(await s.gradeOf(m.id)).toBe("새싹");
    expect((await db.memberGradeRun.findMany({ where: { sellerId: s.seller.id } })).map((r) => r.monthKey).some((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))).toBe(true);
  });

  it("지금 재산정: 꺼져 있어도 돌고(기록은 안 남김) 고정한 회원은 건너뛰며, 기준액이 어긋나면 막는다", async () => {
    const s = await shop(false);
    const m = await s.member(0);
    await s.paid(m.id, 600_000);
    const pinned = await s.member(0);
    await s.paid(pinned.id, 600_000);
    await setMemberGrade(db, s.ctx, pinned.id, { gradeId: s.ids[0], lock: true });
    expect(await recalcNow(db, s.ctx, NOW)).toEqual({ ok: true, ran: true, promoted: 1, demoted: 0, unchanged: 1 });
    expect(await s.gradeOf(m.id)).toBe("실버");
    expect(await s.gradeOf(pinned.id)).toBe("일반");
    expect(await db.memberGradeRun.count()).toBe(0);
    expect(await db.auditLog.count({ where: { action: "member_grade.recalc_now" } })).toBe(1);
    await db.memberGrade.update({ where: { id: s.ids[2] }, data: { minAmount: 50_000 } });
    expect(await recalcNow(db, s.ctx, NOW)).toEqual({ ok: false, reason: "invalid_thresholds_for_run" });
    const staff = await createSellerUser(s.seller.id, { permissions: ["PRODUCT_MANAGE"] });
    await expect(recalcNow(db, { ...s.ctx, actorId: staff.id, isOwner: false, permissions: ["PRODUCT_MANAGE"] })).rejects.toThrow();
  });

  it("고정 기간·사유: 종료일이 지나면 자동 재산정 대상이 되고 고정이 지워진다", async () => {
    const s = await shop();
    const m = await s.member(0);
    await s.paid(m.id, 600_000);
    const day = (d: number) => new Date(NOW.getTime() + d * DAY + 9 * 3600_000).toISOString().slice(0, 10);
    expect(await setMemberGrade(db, s.ctx, m.id, { gradeId: s.ids[0], lock: true, until: "2020-01-01" })).toEqual({ ok: false, reason: "invalid_until" });
    expect(await setMemberGrade(db, s.ctx, m.id, { gradeId: s.ids[0], lock: true, until: "2026-02-30" })).toEqual({ ok: false, reason: "invalid_until" });
    expect(await setMemberGrade(db, s.ctx, m.id, { gradeId: s.ids[0], lock: true, reason: "가".repeat(101) })).toEqual({ ok: false, reason: "invalid_reason" });
    // 지금(실제 시계) 기준 미래 종료일을 넣고, 재산정 시각을 그 뒤로 옮겨 확인한다
    const future = new Date(Date.now() + 10 * DAY + 9 * 3600_000).toISOString().slice(0, 10);
    expect(await setMemberGrade(db, s.ctx, m.id, { gradeId: s.ids[0], lock: true, until: future, reason: "방송 단골" })).toMatchObject({ ok: true });
    const row = await db.memberGradeOverride.findFirstOrThrow({ where: { buyerMemberId: m.id } });
    expect(row.reason).toBe("방송 단골");
    expect(row.until!.getTime()).toBeGreaterThan(Date.now());
    expect(await getMemberGrades(db, s.ctx)).toMatchObject({ lockedCount: 1, locked: [{ reason: "방송 단골" }] });
    // 종료 전에는 건너뜀
    await recalcNow(db, s.ctx, new Date(Date.now()));
    expect(await s.gradeOf(m.id)).toBe("일반");
    // 종료 뒤에는 기준대로: 시각을 옮겨 호출(주문은 그 시각 기준 6개월 안)
    const later = new Date(Date.now() + 12 * DAY);
    await db.order.updateMany({ where: { buyerMemberId: m.id }, data: { paidAt: new Date(later.getTime() - DAY) } });
    expect(await recalcNow(db, s.ctx, later)).toMatchObject({ promoted: 1 });
    expect(await s.gradeOf(m.id)).toBe("실버");
    expect(await db.memberGradeOverride.count({ where: { buyerMemberId: m.id } })).toBe(0);
    expect(day(0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("등급 삭제로 옮긴 회원(휴면 포함)이 다음 재산정에서 기준 등급으로 다시 오른다", async () => {
    const s = await shop();
    const m = await s.member(2); // 실버
    await s.paid(m.id, 600_000);
    const dormant = await s.member(2, "DORMANT");
    expect(await deleteMemberGrade(db, s.ctx, s.ids[2])).toEqual({ ok: true, moved: 2 });
    expect(await s.gradeOf(m.id)).toBe("일반");
    expect(await s.gradeOf(dormant.id)).toBe("일반");
    // 남은 등급: 일반(0)·새싹(100,000)·골드(1,000,000) → 600,000원이면 새싹
    expect(await recalcNow(db, s.ctx, NOW)).toMatchObject({ ok: true, promoted: 1 });
    expect(await s.gradeOf(m.id)).toBe("새싹");
    expect(await deleteMemberGrade(db, s.ctx, s.ids[0])).toEqual({ ok: false, reason: "base_grade_fixed" });
  });
});
