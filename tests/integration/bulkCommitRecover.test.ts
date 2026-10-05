import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/db";
import { COMMIT_INTERRUPTED_MESSAGE, STUCK_COMMIT_MS, recoverStuckBulkCommits } from "../../lib/server/shop-bulk-io/recover";
import { SCHEDULED_JOBS } from "../../lib/server/jobs/scheduler";
import { UNDO_WINDOW_MS, commitProductImport, getBulkJob, previewProductImport, undoProductImport } from "../../lib/server/shop-bulk-io/service";
import type { TenantContext } from "../../lib/server/tenant/context";
import { createSeller, createSellerUser, db, resetDb } from "./helpers";

// 일괄 등록 확정이 서버 중단으로 COMMITTING에 멈춘 작업 복구(shop-bulk-io/recover.ts)
beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const HEAD = "상품명,판매가,상태,설명,차감시점,카테고리,옵션명,옵션추가금,재고,SKU";
const MIN = 60_000;

async function shop() {
  const { seller } = await createSeller();
  const owner = await createSellerUser(seller.id, "OWNER");
  const ctx: TenantContext = { sellerId: seller.id, actorType: "SELLER_USER", actorId: owner.id, isOwner: true, permissions: [], readOnly: false };
  return { seller, ctx };
}

// 상품 2개를 실제로 등록한 뒤, 확정 도중 서버가 죽은 것처럼 COMMITTING으로 되돌린다(만든 상품 id는 남아 있다)
async function crashedJob(ctx: TenantContext, committingAt: Date | null, createdAt?: Date) {
  const text = [HEAD, "카드 A,1000,판매중,,,,기본,0,5,", "카드 B,2000,판매중,,,,기본,0,5,"].join("\r\n");
  const p = await previewProductImport(db, ctx, { csv: text, fileName: "a.csv" });
  if (!p.ok) throw new Error(p.reason);
  const jobId = (p.value as { jobId: string }).jobId;
  const c = await commitProductImport(db, ctx, jobId);
  if (!c.ok) throw new Error(c.reason);
  await db.bulkJob.update({
    where: { id: jobId },
    data: { status: "COMMITTING", committedAt: null, undoUntil: null, failures: [], committingAt, ...(createdAt ? { createdAt } : {}) },
  });
  return jobId;
}

describe("일괄 등록 확정 복구", () => {
  it("확정을 시작하면 시작 시각(committingAt)을 남긴다", async () => {
    const s = await shop();
    const jobId = await crashedJob(s.ctx, null);
    const row = await db.bulkJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe("COMMITTING");
    // 확정 때 남긴 시각은 위에서 일부러 비웠으니, 새로 확정한 작업으로 따로 확인한다
    const text = [HEAD, "카드 C,1000,판매중,,,,기본,0,5,"].join("\r\n");
    const p = await previewProductImport(db, s.ctx, { csv: text, fileName: "b.csv" });
    if (!p.ok) throw new Error(p.reason);
    const id2 = (p.value as { jobId: string }).jobId;
    await commitProductImport(db, s.ctx, id2);
    expect((await db.bulkJob.findUniqueOrThrow({ where: { id: id2 } })).committingAt).toBeInstanceOf(Date);
  });

  it("10분 넘게 멈춘 COMMITTING은 COMMITTED로 마감하고(만든 상품 유지·일부만 등록됨 안내·되돌리기 24시간), 두 번 돌려도 한 번만 마감한다", async () => {
    const s = await shop();
    const now = new Date();
    const jobId = await crashedJob(s.ctx, new Date(now.getTime() - (STUCK_COMMIT_MS + MIN)));
    expect(await recoverStuckBulkCommits(db, now)).toBe(1);
    const row = await db.bulkJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).toBe("COMMITTED");
    expect(row.committedAt?.getTime()).toBe(now.getTime());
    expect(row.undoUntil?.getTime()).toBe(now.getTime() + UNDO_WINDOW_MS);
    expect(row.failures).toEqual([{ row: 0, name: "", message: COMMIT_INTERRUPTED_MESSAGE }]);
    expect(await db.product.count({ where: { sellerId: s.seller.id, deletedAt: null } })).toBe(2);
    expect(await db.auditLog.count({ where: { action: "bulk_io.product_import_interrupted", targetId: jobId, actorType: "SYSTEM" } })).toBe(1);

    // 두 번째 실행은 아무것도 바꾸지 않는다
    expect(await recoverStuckBulkCommits(db, new Date(now.getTime() + 5 * MIN))).toBe(0);
    expect((await db.bulkJob.findUniqueOrThrow({ where: { id: jobId } })).failures).toEqual([{ row: 0, name: "", message: COMMIT_INTERRUPTED_MESSAGE }]);
    expect(await db.auditLog.count({ where: { action: "bulk_io.product_import_interrupted", targetId: jobId } })).toBe(1);

    // 작업 화면은 만든 건수와 안내를 보여 주고, 만든 상품은 되돌릴 수 있다
    const view = await getBulkJob(db, s.ctx, jobId);
    expect(view).toMatchObject({ status: "COMMITTED", createdCount: 2, failedCount: 1, undoable: true });
    expect(view.failures).toEqual([{ row: 0, name: "", message: COMMIT_INTERRUPTED_MESSAGE }]);
    expect(await undoProductImport(db, s.ctx, jobId)).toMatchObject({ ok: true, value: { removedCount: 2 } });
    expect(await db.product.count({ where: { sellerId: s.seller.id, deletedAt: null } })).toBe(0);
  });

  it("방금 시작한 COMMITTING·미리보기·이미 끝난 작업은 건드리지 않고, 시작 시각이 없는 옛 기록은 만든 시각으로 판단한다", async () => {
    const s = await shop();
    const now = new Date();
    const fresh = await crashedJob(s.ctx, new Date(now.getTime() - 2 * MIN));
    const legacyOld = await crashedJob(s.ctx, null, new Date(now.getTime() - 2 * 3600_000));
    const legacyNew = await crashedJob(s.ctx, null, new Date(now.getTime() - 2 * MIN));
    const text = [HEAD, "카드 D,1000,판매중,,,,기본,0,5,"].join("\r\n");
    const pv = await previewProductImport(db, s.ctx, { csv: text, fileName: "c.csv" });
    if (!pv.ok) throw new Error(pv.reason);
    const previewId = (pv.value as { jobId: string }).jobId;
    const pd = await previewProductImport(db, s.ctx, { csv: text, fileName: "d.csv" });
    if (!pd.ok) throw new Error(pd.reason);
    const doneId = (pd.value as { jobId: string }).jobId;
    await commitProductImport(db, s.ctx, doneId);

    expect(await recoverStuckBulkCommits(db, now)).toBe(1);
    const status = async (id: string) => (await db.bulkJob.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(legacyOld)).toBe("COMMITTED");
    expect(await status(fresh)).toBe("COMMITTING");
    expect(await status(legacyNew)).toBe("COMMITTING");
    expect(await status(previewId)).toBe("PREVIEW");
    expect(await status(doneId)).toBe("COMMITTED");
    expect((await db.bulkJob.findUniqueOrThrow({ where: { id: doneId } })).failures).toEqual([]);
  });

  it("정기 실행 목록에 등록돼 있다", () => {
    expect(SCHEDULED_JOBS.map((j) => j.name)).toContain("bulk_job.recover_stuck_commit");
  });
});
