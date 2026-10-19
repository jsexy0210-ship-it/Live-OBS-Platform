import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AdminSessionContext } from "../../lib/server/auth/session";
vi.mock("../../lib/server/billing/subscription", async importOriginal => ({ ...await importOriginal<typeof import("../../lib/server/billing/subscription")>(), dbNow: vi.fn(async () => new Date("2026-10-19T10:00:00Z")) }));
vi.mock("../../lib/server/admin/platformPolicy", async importOriginal => ({ ...await importOriginal<typeof import("../../lib/server/admin/platformPolicy")>(), policyValue: vi.fn(async () => 48) }));
import { getApplicationReview } from "../../lib/server/sellers/applications";
import { listLiveBroadcasts } from "../../lib/server/admin/ops";
const id = "00000000-0000-0000-0000-000000000001";
const actor = "00000000-0000-0000-0000-000000000002";
const admin = (role = "SUPER_ADMIN") => ({ admin: { id: actor, role } }) as AdminSessionContext;
const pending = { id, slug: "review", shopName: "검수 몰", createdAt: new Date("2026-10-01"), businessInfo: {}, reviewReasons: [] };
function dbFixture() { return { seller: { findUnique: vi.fn(async () => ({ status: "PENDING", approvedAt: null, approvedByAdminId: null })), findMany: vi.fn(async (_query: unknown) => [pending]) }, sellerUser: { findMany: vi.fn(async () => []) }, sellerApplicationReview: { findMany: vi.fn(async () => []) }, sellerBusinessLicense: { findMany: vi.fn(async () => [{ sellerId: id, fileName: "license.png", mimeType: "image/png", byteSize: 10, uploadedAt: new Date("2026-10-01") }]) } }; }
beforeEach(() => vi.clearAllMocks());
describe("관리자 단건 상세 조회", () => {
 it("신청 목록 상한·동명이름 검색에 의존하지 않고 정확한 ID를 읽는다", async () => { const db = dbFixture(); const r = await getApplicationReview(db as unknown as PrismaClient, admin(), id); expect(r?.application?.id).toBe(id); expect(db.seller.findMany.mock.calls[0][0]).toMatchObject({ where: { id, status: "PENDING" } }); });
 it("CS 상세는 등록증 메타만 받고 보기 주소를 받지 않는다", async () => { const r = await getApplicationReview(dbFixture() as unknown as PrismaClient, admin("CS"), id); expect(r?.application?.license?.viewUrl).toBeNull(); });
 it("다른 관리자의 승인은 되돌리기 가능으로 표시하지 않는다", async () => { const db = dbFixture(); db.seller.findUnique.mockResolvedValue({ status: "ACTIVE", approvedAt: new Date("2026-10-19T10:00:00Z"), approvedByAdminId: "other" } as never); const r = await getApplicationReview(db as unknown as PrismaClient, admin(), id); expect(r?.undoableUntil).toBeNull(); });
 it("없는 신청은 목록을 조회하지 않고 없는 상태로 반환한다", async () => { const db = dbFixture(); db.seller.findUnique.mockResolvedValue(null as never); expect(await getApplicationReview(db as unknown as PrismaClient, admin(), id)).toBeNull(); expect(db.seller.findMany).not.toHaveBeenCalled(); });
 it("방송 직접 조회는 목록 표시 상한 앞에 정확한 ID 조건을 건다", async () => { const db = { broadcastSession: { findMany: vi.fn(async (_query: unknown) => []) }, queueItem: { groupBy: vi.fn(async () => []) }, payment: { groupBy: vi.fn(async () => []) }, overlayToken: { findMany: vi.fn(async () => []) }, $queryRaw: vi.fn(async () => []) }; const r = await listLiveBroadcasts(db as unknown as PrismaClient, admin(), id); expect(r.items).toEqual([]); expect(db.broadcastSession.findMany.mock.calls[0][0]).toMatchObject({ where: { status: "LIVE", id } }); });
});
