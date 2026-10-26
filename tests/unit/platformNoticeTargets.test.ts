import type { PlatformNotice, PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { AdminSessionContext } from "../../lib/server/auth/session";
import { createPlatformNotice, deletePlatformNotice, targetedFor, updatePlatformNotice } from "../../lib/server/platform-notices/service";

const noticeId = "00000000-0000-4000-8000-000000000001";
const sellerId = "00000000-0000-4000-8000-000000000002";
const admin = { admin: { id: noticeId, role: "CS" } } as AdminSessionContext;
const input = (over: Record<string, unknown> = {}) => ({ title: "공지", body: "본문", category: "GENERAL", audience: "PARTNERS", publish: true, ...over });
const row = { id: noticeId, title: "공지", body: "본문", category: "GENERAL", audience: "PARTNERS", isPinned: false, targetMode: "SPECIFIC", version: 1, publishedAt: new Date(), deletedAt: null, createdAt: new Date(), updatedAt: new Date() } as PlatformNotice;

function fixture(targets = [sellerId]) {
  const tx = {
    $queryRaw: vi.fn(async () => [row]),
    seller: { count: vi.fn(async () => targets.length) },
    platformNoticeTarget: { findMany: vi.fn(async () => targets.map((sellerId) => ({ sellerId }))), deleteMany: vi.fn() },
    platformNotice: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data, targets: (data.targets as { create: { sellerId: string }[] }).create })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...row, ...data, version: 2, targets: data.targets ? (data.targets as { create: { sellerId: string }[] }).create : targets.map((sellerId) => ({ sellerId })) })),
    },
    auditLog: { create: vi.fn(async () => ({ id: noticeId })) },
  };
  const transaction = vi.fn(async (fn: (value: typeof tx) => unknown) => fn(tx));
  return { db: { $transaction: transaction } as unknown as PrismaClient, tx, transaction };
}

describe("공지의 명시 대상과 생략된 대상", () => {
  it("삭제 잠금 안에서 실제 대상 집합을 읽어 전후 감사에 같은 수를 남긴다", async () => {
    const f = fixture([sellerId, "00000000-0000-4000-8000-000000000003"]);
    expect(await deletePlatformNotice(f.db, admin, noticeId, 1)).toEqual({ ok: true });
    expect(f.tx.platformNoticeTarget.findMany).toHaveBeenCalledWith({ where: { noticeId }, select: { sellerId: true } });
    expect(f.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(f.tx.platformNoticeTarget.findMany.mock.invocationCallOrder[0]);
    expect(f.tx.platformNoticeTarget.findMany.mock.invocationCallOrder[0]).toBeLessThan(f.tx.platformNotice.update.mock.invocationCallOrder[0]);
    expect(f.tx.auditLog.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "platform.notice.delete", before: expect.objectContaining({ targetMode: "SPECIFIC", targetCount: 2, deleted: false }), after: expect.objectContaining({ targetMode: "SPECIFIC", targetCount: 2, deleted: true }) }) }));
    expect(f.tx.platformNoticeTarget.deleteMany).not.toHaveBeenCalled();
  });

  it("대상 필드가 없는 기존 생성은 ALL이며 빈 특정 초안과 구분한다", async () => {
    const legacy = fixture();
    const all = await createPlatformNotice(legacy.db, admin, input());
    expect(all.ok && [all.notice.targetMode, all.notice.targetSellerIds]).toEqual(["ALL", []]);
    const draft = fixture([]);
    const specific = await createPlatformNotice(draft.db, admin, input({ targetMode: "SPECIFIC", targetSellerIds: [], publish: false }));
    expect(specific.ok && [specific.notice.targetMode, specific.notice.targetSellerIds, specific.notice.status]).toEqual(["SPECIFIC", [], "draft"]);
  });

  it.each([
    { targetMode: "SPECIFIC", targetSellerIds: [] },
    { targetSellerIds: [sellerId] },
    { targetMode: "ALL", targetSellerIds: [sellerId] },
    { targetMode: "SPECIFIC", targetSellerIds: [sellerId], audience: "PUBLIC" },
  ])("모호하거나 게시 대상이 없는 입력은 쓰기 전에 거절한다: %j", async (over) => {
    const f = fixture();
    expect(await createPlatformNotice(f.db, admin, input(over))).toEqual({ ok: false, reason: "invalid_targets" });
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("기존 공지 수정에서 대상 필드 생략은 대상 관계를 삭제하지 않는다", async () => {
    const f = fixture();
    const r = await updatePlatformNotice(f.db, admin, noticeId, input({ expectedVersion: 1 }));
    expect(r.ok && [r.notice.targetMode, r.notice.targetSellerIds]).toEqual(["SPECIFIC", [sellerId]]);
    expect(f.tx.platformNoticeTarget.deleteMany).not.toHaveBeenCalled();
    expect(f.tx.platformNotice.update.mock.calls[0][0].data).not.toHaveProperty("targets");
  });

  it("ALL 명시 선택만 기존 관계를 지우고 전체로 전환한다", async () => {
    const f = fixture();
    const r = await updatePlatformNotice(f.db, admin, noticeId, input({ expectedVersion: 1, targetMode: "ALL", targetSellerIds: [] }));
    expect(r.ok && [r.notice.targetMode, r.notice.targetSellerIds]).toEqual(["ALL", []]);
    expect(f.tx.platformNoticeTarget.deleteMany).toHaveBeenCalledWith({ where: { noticeId } });
  });

  it("빈 특정 초안 게시와 오래된 버전은 대상·공지·로그를 쓰지 않는다", async () => {
    for (const [targets, expectedVersion, reason] of [[[], 1, "invalid_targets"], [[sellerId], 0, "version_conflict"]] as const) {
      const f = fixture([...targets]);
      expect(await updatePlatformNotice(f.db, admin, noticeId, input({ expectedVersion }))).toMatchObject({ ok: false, reason });
      expect(f.tx.platformNoticeTarget.deleteMany).not.toHaveBeenCalled();
      expect(f.tx.platformNotice.update).not.toHaveBeenCalled();
      expect(f.tx.auditLog.create).not.toHaveBeenCalled();
    }
  });

  it("기존 CS 작성권은 유지하고 운영 역할에는 쓰기를 허용하지 않는다", async () => {
    const f = fixture();
    await expect(createPlatformNotice(f.db, { admin: { id: noticeId, role: "OPERATIONS" } } as AdminSessionContext, input())).rejects.toMatchObject({ status: 403 });
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it("특정 대상 조건은 목록 커서 OR를 덮지 않고 현재 tenant를 명시한다", () => {
    const cursor = { OR: [{ id: { lt: noticeId } }] };
    expect({ ...cursor, ...targetedFor(sellerId) }).toEqual({ ...cursor, NOT: { targetMode: "SPECIFIC", targets: { none: { sellerId } } } });
    expect(targetedFor()).toEqual({ NOT: { targetMode: "SPECIFIC" } });
  });
});
