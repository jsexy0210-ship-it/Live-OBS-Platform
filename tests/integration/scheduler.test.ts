import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SCHEDULED_JOBS, runScheduledJobs, type ScheduledJob } from "../../lib/server/jobs/scheduler";
import { createSeller, db, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await db.$disconnect();
});

describe("앱 안 정기 실행", () => {
  it("한 번 돌면 모든 쇼핑몰의 기간이 끝난 재가입 제한 기록을 지우고, 안 끝난 기록은 남긴다", async () => {
    const { seller: a } = await createSeller();
    const { seller: b } = await createSeller();
    const now = new Date();
    await db.buyerRejoinBlock.createMany({
      data: [
        { sellerId: a.id, ciHash: "ci-a-old", expiresAt: new Date(now.getTime() - 1000) },
        { sellerId: b.id, ciHash: "ci-b-old", expiresAt: new Date(now.getTime() - 1000) },
        { sellerId: b.id, ciHash: "ci-b-live", expiresAt: new Date(now.getTime() + 86400_000) },
      ],
    });
    expect(SCHEDULED_JOBS.map((j) => j.name)).toContain("buyer_rejoin_block.purge_expired");
    expect((await runScheduledJobs(db, now)).find((r) => r.name === "buyer_rejoin_block.purge_expired")).toEqual({ name: "buyer_rejoin_block.purge_expired", status: "done", count: 2 });
    expect((await db.buyerRejoinBlock.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] })).map((r) => r.ciHash)).toEqual(["ci-b-live"]);
  });

  it("한 번 돌면 모든 쇼핑몰의 끝난 미가입 본인확인을 비식별하고(행은 남김) 3개월 지난 가입 본인확인 요청 IP를 비운다", async () => {
    const { seller: a } = await createSeller();
    const { seller: b } = await createSeller();
    const now = new Date();
    const old = new Date(now);
    old.setUTCMonth(old.getUTCMonth() - 4);
    const base = { purpose: "BUYER_SIGNUP" as const, provider: "fake", method: "SMS" as const, requestIp: "203.0.113.9" };
    const expired = await db.identityVerification.create({ data: { ...base, sellerId: a.id, requestId: "r-a", status: "PENDING", name: "가", phone: "01011112222", requestedPhone: "01011112222", expiresAt: new Date(now.getTime() - 1000) } });
    const live = await db.identityVerification.create({ data: { ...base, sellerId: b.id, requestId: "r-b", status: "PENDING", name: "나", requestedPhone: "01022223333", expiresAt: new Date(now.getTime() + 600_000) } });
    const signedUp = await db.identityVerification.create({ data: { ...base, sellerId: b.id, requestId: "r-c", status: "VERIFIED", ciHash: "ci", verifiedAt: old, consumedAt: old, createdAt: old, expiresAt: old } });
    const out = await runScheduledJobs(db, now);
    expect(out.filter((r) => r.name.startsWith("identity_verification.")).map((r) => r.status)).toEqual(["done", "done", "done"]);
    expect(await db.identityVerification.findUniqueOrThrow({ where: { id: expired.id } })).toMatchObject({ name: null, phone: null, requestedPhone: null, anonymizedAt: now, status: "PENDING", requestIp: "203.0.113.9" });
    expect(await db.identityVerification.findUniqueOrThrow({ where: { id: live.id } })).toMatchObject({ name: "나", anonymizedAt: null });
    expect((await db.identityVerification.findUniqueOrThrow({ where: { id: signedUp.id } })).requestIp).toBeNull();
  });

  it("다른 인스턴스가 같은 작업을 돌고 있으면(잠금) 건너뛰고, 작업 하나가 실패해도 다음 작업은 돈다", async () => {
    let ran = 0;
    const jobs: ScheduledJob[] = [
      { name: "test.fail", run: async () => { throw new Error("boom"); } },
      { name: "test.locked", run: async () => { ran++; return 1; } },
      { name: "test.ok", run: async () => { ran++; return 3; } },
    ];
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedReady = new Promise<void>((r) => (locked = r));
    const holder = db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"scheduled_job:test.locked"}))`;
      locked();
      await held;
    }, { timeout: 20_000 });
    await lockedReady;
    const out = await runScheduledJobs(db, new Date(), jobs);
    release();
    await holder;
    expect(out).toEqual([
      { name: "test.fail", status: "failed", error: "boom" },
      { name: "test.locked", status: "skipped" },
      { name: "test.ok", status: "done", count: 3 },
    ]);
    expect(ran).toBe(1);
  });
});
