import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createAdminSession, resolveAdminSession } from "../../lib/server/auth/session";
import { sellerFeatures } from "../../lib/server/billing/features";
import { listPlanMigrationNoticeTargets } from "../../lib/server/billing/plans";
import { FakeBillingProvider } from "../../lib/server/billing/provider";
import { sealBillingKey } from "../../lib/server/billing/secret";
import { registerCardAndPay, renewDueSubscriptions, settlePayment } from "../../lib/server/billing/subscription";
import { prisma } from "../../lib/server/db";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createAdmin, createSeller, createSellerUser, db, resetDb, seedPlans } from "./helpers";

// ONQ 1-C-1: 기존 STANDARD 이전(ONQ_PLAN E1-C, ARCHITECTURE 4.8.0). 마이그레이션의 BACKFILL 부분을 이전 전 상태에 그대로 다시 돌려
// 경우마다 「통합 권한·체험 종료일·결제일·유예·재시도·해지 예약 그대로, 다음 결제 금액은 고지 규칙대로」를 확인한다.
beforeAll(() => {
  process.env.BILLING_KEY_SECRET = "test-billing-key-secret-0123456789abcdef";
  process.env.BILLING_PROVIDER = "fake";
});
let plans: Awaited<ReturnType<typeof seedPlans>>;
beforeEach(async () => {
  await resetDb();
  plans = await seedPlans();
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const DAY = 86_400_000;
const ALL = ["OVERLAY", "EXTERNAL_INTEGRATION", "STORE_OPERATIONS"];
const at = (days: number) => new Date(Date.now() + days * DAY);

const MIGRATION = readFileSync(join(__dirname, "../../prisma/migrations/20261004150000_onq_plans/migration.sql"), "utf8");
const BACKFILL = MIGRATION.slice(MIGRATION.indexOf("-- BACKFILL"))
  .split(";")
  .map((s) => s.trim())
  .filter((s) => /UPDATE/.test(s));

async function backfill() {
  expect(BACKFILL).toHaveLength(3);
  for (const sql of BACKFILL) await db.$executeRawUnsafe(sql);
}

const ctxOf = (sellerId: string, actorId: string): TenantContext => ({ sellerId, actorType: "SELLER_USER", actorId, isOwner: true, permissions: [], readOnly: false });

// 이전 전 상태의 판매자: 판매자 플랜 없음(planId null), 구독이 있으면 STANDARD
async function legacySeller(trialEndsAt: Date | null, sub?: Record<string, unknown>) {
  const { seller } = await createSeller();
  await db.seller.update({ where: { id: seller.id }, data: { trialEndsAt, planId: null } });
  const owner = await createSellerUser(seller.id, "OWNER");
  const subscription = sub
    ? await db.sellerSubscription.create({
        data: { sellerId: seller.id, planId: plans.STANDARD.id, billingKeyCipher: sealBillingKey("bk-" + seller.id, seller.id), cardLabel: "카드", subscribedAt: at(-60), ...sub },
      })
    : null;
  return { seller, owner, ctx: ctxOf(seller.id, owner.id), subscription };
}

const SNAPSHOT_FIELDS = {
  status: true,
  nextChargeAt: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  billingAnchorAt: true,
  cancelAtPeriodEnd: true,
  graceUntil: true,
  retryCount: true,
  canceledAt: true,
  subscribedAt: true,
} as const;

async function scenario() {
  const trialSub = await legacySeller(at(5), { status: "ACTIVE", nextChargeAt: at(5) });
  const paying = await legacySeller(at(-40), {
    status: "ACTIVE",
    currentPeriodStart: at(-20),
    currentPeriodEnd: at(10),
    billingAnchorAt: at(-20),
    nextChargeAt: at(9),
  });
  const noSubTrial = await legacySeller(at(3));
  const noSubLocked = await legacySeller(at(-3));
  const canceled = await legacySeller(at(-100), { status: "CANCELED", canceledAt: at(-10), currentPeriodEnd: at(-10), nextChargeAt: null });
  const pastDue = await legacySeller(at(-40), {
    status: "PAST_DUE",
    currentPeriodStart: at(-31),
    currentPeriodEnd: at(-1),
    billingAnchorAt: at(-31),
    nextChargeAt: at(1),
    graceUntil: at(5),
    retryCount: 1,
  });
  const cancelReserved = await legacySeller(at(-40), {
    status: "ACTIVE",
    currentPeriodStart: at(-20),
    currentPeriodEnd: at(10),
    billingAnchorAt: at(-20),
    nextChargeAt: at(10),
    cancelAtPeriodEnd: true,
  });
  // 해지 예약 기간이 이미 끝났고 예약 실행이 아직 CANCELED로 바꾸지 않은 구독(새로 구독하면 새 가입자)
  const cancelEnded = await legacySeller(at(-60), {
    status: "ACTIVE",
    currentPeriodStart: at(-31),
    currentPeriodEnd: at(-1),
    billingAnchorAt: at(-31),
    nextChargeAt: at(-1),
    cancelAtPeriodEnd: true,
  });
  return { trialSub, paying, noSubTrial, noSubLocked, canceled, pastDue, cancelReserved, cancelEnded };
}

describe("STANDARD → 쇼핑몰 통합 이전(백필)", () => {
  it("모든 경우를 통합으로 옮기고 상태·체험 종료일·결제일·유예·재시도·해지 예약은 그대로, 스냅숏은 결제가 이어지는 구독만, 권한은 통합 3종", async () => {
    const s = await scenario();
    const subIds = Object.values(s).flatMap((x) => (x.subscription ? [x.subscription.id] : []));
    const before = await db.sellerSubscription.findMany({ where: { id: { in: subIds } }, select: { id: true, ...SNAPSHOT_FIELDS }, orderBy: { id: "asc" } });
    const sellersBefore = await db.seller.findMany({ select: { id: true, trialEndsAt: true }, orderBy: { id: "asc" } });

    await backfill();

    expect(await db.seller.count({ where: { planId: { not: plans.INTEGRATED.id } } })).toBe(0);
    expect(await db.sellerSubscription.count({ where: { planId: { not: plans.INTEGRATED.id } } })).toBe(0);
    expect(await db.sellerSubscription.findMany({ where: { id: { in: subIds } }, select: { id: true, ...SNAPSHOT_FIELDS }, orderBy: { id: "asc" } })).toEqual(before);
    expect(await db.seller.findMany({ select: { id: true, trialEndsAt: true }, orderBy: { id: "asc" } })).toEqual(sellersBefore);

    const snap = async (x: { subscription: { id: string } | null }) =>
      (await db.sellerSubscription.findUniqueOrThrow({ where: { id: x.subscription!.id }, select: { legacyPrice: true, legacyPriceNoticeSentAt: true } }));
    for (const x of [s.trialSub, s.paying, s.pastDue, s.cancelReserved]) expect(await snap(x)).toEqual({ legacyPrice: 199000, legacyPriceNoticeSentAt: null });
    for (const x of [s.canceled, s.cancelEnded]) expect(await snap(x)).toEqual({ legacyPrice: null, legacyPriceNoticeSentAt: null });

    // 체험을 받은 적 있는 기존 판매자는 첫 결제 전이어도 통합 권한(잠긴 판매자는 잠금 규칙이 막음)
    for (const x of Object.values(s)) expect(await sellerFeatures(db, x.seller.id)).toEqual(ALL);
    // 다시 돌려도 바뀌지 않는다(결정적)
    const once = await db.sellerSubscription.findMany({ orderBy: { id: "asc" } });
    await backfill();
    expect(await db.sellerSubscription.findMany({ orderBy: { id: "asc" } })).toEqual(once);
  });

  it("스냅숏 금액은 구독 시작 때 적용되던 STANDARD 가격이다(가격 기록 규칙, 고지 30일이 지난 변경은 새 가격)", async () => {
    // 구독 시작(60일 전) 뒤 10일 전에 정한 STANDARD 가격 250,000원은 아직 고지 기간 → 시작 때 가격 199,000원
    await db.subscriptionPriceChange.createMany({
      data: [
        { planId: plans.STANDARD.id, listPrice: 300000, salePrice: 199000, changedAt: new Date("2000-01-01T00:00:00Z") },
        { planId: plans.STANDARD.id, listPrice: 300000, salePrice: 250000, changedAt: at(-10) },
      ],
    });
    const recent = await legacySeller(at(-40), { status: "ACTIVE", currentPeriodEnd: at(10), billingAnchorAt: at(-20), nextChargeAt: at(9) });
    // 40일 전에 정한 가격 150,000원은 고지 기간이 끝나 기존 구독자에게도 적용 중
    const older = await legacySeller(at(-40), { status: "ACTIVE", currentPeriodEnd: at(10), billingAnchorAt: at(-20), nextChargeAt: at(9) });
    await db.subscriptionPriceChange.create({ data: { planId: plans.STANDARD.id, listPrice: 300000, salePrice: 150000, changedAt: at(-40) } });
    await db.subscriptionPriceChange.deleteMany({ where: { salePrice: 250000 } });
    await backfill();
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: older.subscription!.id } })).legacyPrice).toBe(150000);
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: recent.subscription!.id } })).legacyPrice).toBe(150000);
  });
});

describe("이전 뒤 청구 금액(고지 규칙)", () => {
  const charges = (sellerId: string) => db.subscriptionPayment.findMany({ where: { sellerId }, orderBy: { createdAt: "asc" }, select: { amount: true, status: true } });

  it("결제 중 구독: 고지를 보내지 않았으면(noticeSentAt null) 몇 달이 지나도 이전 전 금액, 새 가격 청구 0건", async () => {
    const { paying } = await scenario();
    await backfill();
    const provider = new FakeBillingProvider();
    await renewDueSubscriptions(db, provider, { now: at(9) });
    await renewDueSubscriptions(db, provider, { now: at(40) });
    await renewDueSubscriptions(db, provider, { now: at(70) });
    const list = await charges(paying.seller.id);
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.every((p) => p.amount === 199000)).toBe(true);
    expect(list.filter((p) => p.amount === 179000)).toHaveLength(0);
  });

  it("고지 발송 30일 전에는 이전 전 금액, 고지 발송 + 30일 뒤 결제부터 통합 금액", async () => {
    const { paying } = await scenario();
    await backfill();
    const provider = new FakeBillingProvider();
    await db.sellerSubscription.update({ where: { id: paying.subscription!.id }, data: { legacyPriceNoticeSentAt: at(-20) } });
    await renewDueSubscriptions(db, provider, { now: at(9) }); // 고지 + 29일
    expect((await charges(paying.seller.id)).map((p) => p.amount)).toEqual([199000]);
    await renewDueSubscriptions(db, provider, { now: at(40) }); // 고지 + 60일
    expect((await charges(paying.seller.id)).map((p) => p.amount)).toEqual([199000, 179000]);
  });

  it("체험 중 카드 등록한 구독: 체험이 끝나는 첫 결제도 이전 전 금액(고지 전)", async () => {
    const { trialSub } = await scenario();
    await backfill();
    await renewDueSubscriptions(db, new FakeBillingProvider(), { now: at(5) });
    expect(await charges(trialSub.seller.id)).toEqual([{ amount: 199000, status: "PAID" }]);
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: trialSub.subscription!.id } })).planId).toBe(plans.INTEGRATED.id);
  });

  it("유예 중(PAST_DUE) 구독: 유예 마감·재시도 일정 그대로, 다음 재시도는 통합 플랜·이전 전 금액으로 청구", async () => {
    const { pastDue } = await scenario();
    await backfill();
    expect(await sellerFeatures(db, pastDue.seller.id)).toEqual(ALL);
    await renewDueSubscriptions(db, new FakeBillingProvider(), { now: at(1) });
    expect(await charges(pastDue.seller.id)).toEqual([{ amount: 199000, status: "PAID" }]);
    expect(await db.sellerSubscription.findUniqueOrThrow({ where: { id: pastDue.subscription!.id } })).toMatchObject({ planId: plans.INTEGRATED.id, status: "ACTIVE" });
  });

  it("기간 끝 해지 예약 구독: 예약·기간 끝 날짜 그대로, 기간 끝에 갱신 결제 0건으로 해지", async () => {
    const { cancelReserved } = await scenario();
    await backfill();
    expect(await db.sellerSubscription.findUniqueOrThrow({ where: { id: cancelReserved.subscription!.id } })).toMatchObject({ cancelAtPeriodEnd: true });
    await renewDueSubscriptions(db, new FakeBillingProvider(), { now: at(10) });
    expect(await charges(cancelReserved.seller.id)).toEqual([]);
    expect((await db.sellerSubscription.findUniqueOrThrow({ where: { id: cancelReserved.subscription!.id } })).status).toBe("CANCELED");
  });

  it("해지 보관 구독을 다시 결제해 재시작하면 그때 통합 런칭가(스냅숏 없음). 스냅숏이 남아 있던 구독도 재시작하면 비우고 통합 금액", async () => {
    const { canceled, cancelEnded } = await scenario();
    await backfill();
    const provider = new FakeBillingProvider();
    expect(await registerCardAndPay(db, provider, canceled.ctx, { authKey: "auth" })).toMatchObject({ ok: true, charged: true });
    expect(await charges(canceled.seller.id)).toEqual([{ amount: 179000, status: "PAID" }]);
    // 반례: 이전 뒤 해지된 구독(스냅숏이 남은 채 CANCELED)도 재시작하면 새 가입자 가격
    await db.sellerSubscription.update({ where: { id: cancelEnded.subscription!.id }, data: { legacyPrice: 199000 } });
    expect(await registerCardAndPay(db, provider, cancelEnded.ctx, { authKey: "auth" })).toMatchObject({ ok: true, charged: true });
    expect(await charges(cancelEnded.seller.id)).toEqual([{ amount: 179000, status: "PAID" }]);
    expect(await db.sellerSubscription.findUniqueOrThrow({ where: { id: cancelEnded.subscription!.id } })).toMatchObject({ legacyPrice: null, legacyPriceNoticeSentAt: null });
  });

  it("구독 행 없는 판매자: 체험 중이면 카드만 등록하고 체험 끝 첫 결제는 통합 런칭가, 체험이 끝나 잠긴 판매자는 등록 때 바로 통합 런칭가", async () => {
    const { noSubTrial, noSubLocked } = await scenario();
    await backfill();
    const provider = new FakeBillingProvider();
    expect(await registerCardAndPay(db, provider, noSubTrial.ctx, { authKey: "auth" })).toMatchObject({ ok: true, charged: false });
    expect(await db.sellerSubscription.findUniqueOrThrow({ where: { sellerId: noSubTrial.seller.id } })).toMatchObject({ planId: plans.INTEGRATED.id, legacyPrice: null });
    await renewDueSubscriptions(db, provider, { now: at(3) });
    expect(await charges(noSubTrial.seller.id)).toEqual([{ amount: 179000, status: "PAID" }]);

    expect(await registerCardAndPay(db, provider, noSubLocked.ctx, { authKey: "auth" })).toMatchObject({ ok: true, charged: true });
    expect(await charges(noSubLocked.seller.id)).toEqual([{ amount: 179000, status: "PAID" }]);
  });

  it("고지 대상 목록: 스냅숏이 있고 고지를 보내지 않은 구독만(해지·해지 예약이 끝난 구독은 빠지고, 보낸 구독도 빠짐)", async () => {
    const s = await scenario();
    await backfill();
    await db.sellerSubscription.update({ where: { id: s.paying.subscription!.id }, data: { legacyPriceNoticeSentAt: new Date() } });
    const admin = await createAdmin("SUPER_ADMIN");
    const session = await createAdminSession(db, admin.id, {});
    const targets = await listPlanMigrationNoticeTargets(db, (await resolveAdminSession(db, session.token))!);
    expect(targets.map((t) => t.sellerId).sort()).toEqual([s.trialSub, s.pastDue, s.cancelReserved].map((x) => x.seller.id).sort());
    expect(targets[0]).toMatchObject({ oldPrice: 199000, newPlan: "INTEGRATED", newPrice: 179000 });
    const ops = await createAdmin("OPERATIONS");
    const opsSession = await createAdminSession(db, ops.id, {});
    await expect(listPlanMigrationNoticeTargets(db, (await resolveAdminSession(db, opsSession.token))!)).rejects.toMatchObject({ status: 403 });
  });
});

describe("신규 가입(이전 뒤)", () => {
  it("통합 신규 판매자는 체험 없이 카드 등록 때 바로 179,000원, 오버레이 전용은 7일 체험 뒤 69,000원. STANDARD는 쓰지 않는다", async () => {
    const provider = new FakeBillingProvider();
    const i = await legacySeller(null);
    await db.seller.update({ where: { id: i.seller.id }, data: { planId: plans.INTEGRATED.id } });
    expect(await registerCardAndPay(db, provider, i.ctx, { authKey: "auth" })).toMatchObject({ ok: true, charged: true });
    expect(await db.subscriptionPayment.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: i.seller.id }, select: { amount: true } })).toEqual([{ amount: 179000 }]);

    const o = await legacySeller(at(7));
    await db.seller.update({ where: { id: o.seller.id }, data: { planId: plans.OVERLAY_ONLY.id } });
    expect(await registerCardAndPay(db, provider, o.ctx, { authKey: "auth" })).toMatchObject({ ok: true, charged: false });
    await renewDueSubscriptions(db, provider, { now: at(7) });
    expect(await db.subscriptionPayment.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: o.seller.id }, select: { amount: true } })).toEqual([{ amount: 69000 }]);
    expect(await db.sellerSubscription.count({ where: { planId: plans.STANDARD.id } })).toBe(0);
  });
});

// ONQ 1-C-2 런칭 할인 계정당 1회(#186 Codex): 새 플랜 뒤 이 마이그레이션 전에 확정된 런칭가 청구가 있는 판매자는 사용 시각을 채운다.
const PLAN_CHANGE = readFileSync(join(__dirname, "../../prisma/migrations/20261004155000_plan_change/migration.sql"), "utf8");
const LAUNCH_BACKFILL = PLAN_CHANGE.slice(PLAN_CHANGE.indexOf("-- BACKFILL"))
  .split(";")
  .map((s) => s.trim())
  .filter((s) => /UPDATE/.test(s));

describe("런칭 할인 사용 백필(20261004155000)", () => {
  it("새 플랜 뒤 확정된 런칭가 청구만 첫 확정 시각으로 채우고, 스냅숏·이전 전·실패·환불 대상 청구는 세지 않는다. 진행 중 런칭가 청구는 확정되면 남긴다", async () => {
    const base = Date.now();
    const t = (days: number) => new Date(base + days * DAY);
    expect(LAUNCH_BACKFILL).toHaveLength(2);
    // 새 플랜 행이 생긴 때(20261004150000 적용 시각)
    await db.subscriptionPlan.updateMany({ data: { createdAt: t(-30) } });

    async function sellerWith(planId: string, sub: Record<string, unknown>, payments: { status: "PAID" | "FAILED" | "PENDING"; createdAt: Date; refund?: boolean }[]) {
      const { seller } = await createSeller();
      await db.seller.update({ where: { id: seller.id }, data: { planId, launchDiscountUsedAt: null } });
      const s = await db.sellerSubscription.create({
        data: { sellerId: seller.id, planId, billingKeyCipher: sealBillingKey("bk-" + seller.id, seller.id), cardLabel: "카드", status: "ACTIVE", ...sub },
      });
      for (const p of payments) {
        const row = await db.subscriptionPayment.create({
          data: { sellerId: seller.id, subscriptionId: s.id, amount: 1, status: p.status, paidAt: p.status === "PAID" ? p.createdAt : null, createdAt: p.createdAt, periodStart: p.createdAt, periodEnd: new Date(p.createdAt.getTime() + 30 * DAY) },
        });
        if (p.refund) await db.auditLog.create({ data: { actorType: "SYSTEM", sellerId: seller.id, action: "subscription.refund_required", targetType: "SubscriptionPayment", targetId: row.id } });
      }
      return seller.id;
    }
    const usedAt = async (id: string) => (await db.seller.findUniqueOrThrow({ where: { id }, select: { launchDiscountUsedAt: true } })).launchDiscountUsedAt;

    // 새 가입: 런칭가 두 번 확정 → 첫 확정 시각
    const fresh = await sellerWith(plans.OVERLAY_ONLY.id, { createdAt: t(-20), subscribedAt: t(-20) }, [
      { status: "FAILED", createdAt: t(-20) },
      { status: "PAID", createdAt: t(-19) },
      { status: "PAID", createdAt: t(-2) },
    ]);
    // 실패·대기만 → 그대로
    const unpaid = await sellerWith(plans.INTEGRATED.id, { createdAt: t(-10), subscribedAt: t(-10) }, [
      { status: "FAILED", createdAt: t(-10) },
      { status: "PENDING", createdAt: t(-1) },
    ]);
    // 해지 뒤 확정돼 환불 대상 → 그대로
    const refund = await sellerWith(plans.INTEGRATED.id, { createdAt: t(-10), subscribedAt: t(-10), status: "CANCELED", canceledAt: t(-9) }, [
      { status: "PAID", createdAt: t(-10), refund: true },
    ]);
    // 이전된 구독, 스냅숏 유지(고지 전) → 스냅숏 청구라 그대로
    const snapshot = await sellerWith(plans.INTEGRATED.id, { createdAt: t(-90), subscribedAt: t(-90), legacyPrice: 199000 }, [
      { status: "PAID", createdAt: t(-100) },
      { status: "PAID", createdAt: t(-5) },
    ]);
    // 이전된 구독, 고지 + 30일 뒤 청구 → 그 청구부터 런칭가
    const noticed = await sellerWith(plans.INTEGRATED.id, { createdAt: t(-90), subscribedAt: t(-90), legacyPrice: 199000, legacyPriceNoticeSentAt: t(-40) }, [
      { status: "PAID", createdAt: t(-20) },
      { status: "PAID", createdAt: t(-8) },
    ]);
    // 이전 전 STANDARD 결제만 있고 해지 → 그대로
    const standardOnly = await sellerWith(plans.INTEGRATED.id, { createdAt: t(-90), subscribedAt: t(-90), status: "CANCELED", canceledAt: t(-40) }, [
      { status: "PAID", createdAt: t(-60) },
    ]);
    // 이전된 구독, 스냅숏 청구 뒤 해지·재구독(스냅숏 비움). 재구독 청구가 실패면 그대로, 확정이면 그 시각
    const restartFailed = await sellerWith(plans.INTEGRATED.id, { createdAt: t(-90), subscribedAt: t(-3) }, [
      { status: "PAID", createdAt: t(-25) },
      { status: "FAILED", createdAt: t(-3) },
    ]);
    const restartPaid = await sellerWith(plans.INTEGRATED.id, { createdAt: t(-90), subscribedAt: t(-3) }, [
      { status: "PAID", createdAt: t(-25) },
      { status: "PAID", createdAt: t(-3) },
    ]);
    // STANDARD 플랜 구독의 청구 → 그대로
    const standardPlan = await sellerWith(plans.STANDARD.id, { createdAt: t(-10), subscribedAt: t(-10) }, [{ status: "PAID", createdAt: t(-10) }]);
    // 진행 중 런칭가 청구 → 지금은 그대로, 마이그레이션 뒤 확정되면 사용으로 남긴다
    const pending = await sellerWith(plans.OVERLAY_ONLY.id, { createdAt: t(-1), subscribedAt: t(-1) }, [{ status: "PENDING", createdAt: t(-1) }]);
    // 이미 사용 시각이 있으면 덮어쓰지 않는다
    const already = await sellerWith(plans.INTEGRATED.id, { createdAt: t(-10), subscribedAt: t(-10) }, [{ status: "PAID", createdAt: t(-10) }]);
    await db.seller.update({ where: { id: already }, data: { launchDiscountUsedAt: t(-1) } });

    for (const sql of LAUNCH_BACKFILL) await db.$executeRawUnsafe(sql);

    expect(await usedAt(fresh)).toEqual(t(-19));
    expect(await usedAt(noticed)).toEqual(t(-8));
    expect(await usedAt(restartPaid)).toEqual(t(-3));
    expect(await usedAt(already)).toEqual(t(-1));
    for (const id of [unpaid, refund, snapshot, standardOnly, restartFailed, pending, standardPlan]) expect(await usedAt(id), id).toBeNull();
    const flags = async (id: string) => (await db.subscriptionPayment.findMany({ where: { sellerId: id }, select: { launchDiscount: true }, orderBy: { createdAt: "asc" } })).map((p) => p.launchDiscount);
    expect(await flags(snapshot)).toEqual([false, false]);
    expect(await flags(noticed)).toEqual([false, true]);
    expect(await flags(restartPaid)).toEqual([false, true]);
    expect(await flags(standardOnly)).toEqual([false]);

    // 다시 돌려도 바뀌지 않는다
    const state = async () => [
      await db.seller.findMany({ select: { id: true, launchDiscountUsedAt: true }, orderBy: { id: "asc" } }),
      await db.subscriptionPayment.findMany({ select: { id: true, launchDiscount: true }, orderBy: { id: "asc" } }),
    ];
    const once = await state();
    for (const sql of LAUNCH_BACKFILL) await db.$executeRawUnsafe(sql);
    expect(await state()).toEqual(once);

    const p = await db.subscriptionPayment.findFirstOrThrow({ orderBy: [{ createdAt: "asc" }, { id: "asc" }], where: { sellerId: pending } });
    await settlePayment(db, p.id, { ok: true, paymentId: "pg-1", receiptUrl: null }, { actorType: "SYSTEM", actorId: null, now: t(0) });
    expect(await usedAt(pending)).toEqual(t(0));
  });
});
