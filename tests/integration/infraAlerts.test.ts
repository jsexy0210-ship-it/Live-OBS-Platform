import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createAdminSession, resolveAdminSession } from "../../lib/server/auth/session";
import { listAdminAlerts } from "../../lib/server/admin-alerts/service";
import { prisma } from "../../lib/server/db";
import { SCHEDULED_JOBS } from "../../lib/server/jobs/scheduler";
import { recordConnectionResult } from "../../lib/server/ops/connections";
import type { InfraMeasure } from "../../lib/server/ops/infra";
import { createAdmin, db, resetDb } from "./helpers";

// 디스크·메모리 값은 시험에서 정한다(실제 서버 값에 기대지 않기). 나머지(DB 연결·백업)는 정상 값.
let diskPct = 10;
vi.mock("../../lib/server/ops/infra", async (orig) => {
  const actual = await orig<typeof import("../../lib/server/ops/infra")>();
  return {
    ...actual,
    measureInfra: async (_db: unknown, now = new Date()): Promise<InfraMeasure> => ({
      takenAt: now, instance: "test-1", diskTotalBytes: 100, diskUsedBytes: diskPct, memTotalBytes: 100, memUsedBytes: 10, cpuCount: 2, load1: 0.1,
      dbSizeBytes: 1, dbConnections: 1, dbMaxConnections: 100, backupLastAt: null, backupCount: null, backupBytes: null,
    }),
  };
});
const { evaluateInfraAlerts } = await import("../../lib/server/ops/infraAlerts");

beforeEach(async () => {
  diskPct = 10;
  await resetDb();
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const T0 = new Date("2026-10-06T03:00:00Z");
const adminCtx = async (role: "SUPER_ADMIN" | "OPERATIONS") => {
  const a = await createAdmin(role);
  const s = await createAdminSession(db, a.id, {});
  return (await resolveAdminSession(prisma, s.token))!;
};
const alerts = () => db.adminAlert.findMany({ orderBy: { createdAt: "asc" } });

describe("인프라 알림", () => {
  it("용량 기준 초과: 경고는 하루 한 번, 위험으로 오르면 새로 알리고, 다음 날엔 다시 알린다. 정상이면 알림 없음", async () => {
    expect(await evaluateInfraAlerts(db, T0)).toBe(0);
    diskPct = 85;
    expect(await evaluateInfraAlerts(db, T0)).toBe(1);
    expect(await evaluateInfraAlerts(db, new Date(T0.getTime() + 3_600_000))).toBe(0);
    diskPct = 95;
    expect(await evaluateInfraAlerts(db, new Date(T0.getTime() + 7_200_000))).toBe(1);
    expect(await evaluateInfraAlerts(db, new Date(T0.getTime() + 86_400_000))).toBe(1);
    const rows = await alerts();
    expect(rows.map((r) => [r.kind, r.severity])).toEqual([["INFRA_DISK", "WARNING"], ["INFRA_DISK", "URGENT"], ["INFRA_DISK", "URGENT"]]);
    expect(rows[0]).toMatchObject({ title: "디스크 사용률 85%(경고 기준 80%)", linkPath: "/admin/ops/infra", targetRoles: ["SUPER_ADMIN"] });
  });

  it("한도 정지: 도우미·외부 API 사용액이 한도에 닿으면 한 달에 한 번 알린다", async () => {
    await db.assistantMonthUsage.create({ data: { month: "2026-10", usedMilliWon: 10_000_000 } });
    await db.externalApiUsage.create({ data: { provider: "gemini", period: "2026-10", usedWon: 10_000, limitWon: 10_000, stoppedAt: T0 } });
    expect(await evaluateInfraAlerts(db, T0)).toBe(2);
    expect(await evaluateInfraAlerts(db, new Date(T0.getTime() + 86_400_000))).toBe(0);
    const rows = await alerts();
    expect(rows.map((r) => r.title).sort()).toEqual(["자동 연결(gemini) 월 한도 도달, 기능 정지", "도우미 월 한도 도달, 기능 정지"].sort());
    expect(rows.every((r) => r.kind === "INFRA_LIMIT_STOPPED" && r.severity === "WARNING")).toBe(true);
  });

  it("외부 연결: 만료 30일 이내는 경고, 7일 이내·지난 것은 긴급, 만료일을 바꾸면 다시 알린다. 인증 오류는 오류가 난 때마다 한 번", async () => {
    const exp = (days: number) => new Date(T0.getTime() + days * 86_400_000);
    const set = (key: string, d: Date | null) => db.externalConnection.upsert({ where: { key }, create: { key, expiresAt: d }, update: { expiresAt: d } });
    await set("mail", exp(20));
    await set("payment_gateway", exp(3));
    await set("identity_verification", exp(-2));
    await set("nts_business_status", exp(90));
    expect(await evaluateInfraAlerts(db, T0)).toBe(3);
    expect(await evaluateInfraAlerts(db, T0)).toBe(0);
    const by = Object.fromEntries((await alerts()).map((r) => [r.title.split(" ")[0], r.severity]));
    expect(by).toMatchObject({ "메일": "WARNING", "결제대행사": "URGENT", "본인인증": "URGENT" });
    await set("mail", exp(5));
    expect(await evaluateInfraAlerts(db, T0)).toBe(1);

    await recordConnectionResult(db, "gemini", "auth_error", "http_401", new Date(T0.getTime() - 60_000));
    expect(await evaluateInfraAlerts(db, T0)).toBe(1);
    expect(await evaluateInfraAlerts(db, T0)).toBe(0);
    await recordConnectionResult(db, "gemini", "auth_error", "http_401", new Date(T0.getTime() - 30_000));
    expect(await evaluateInfraAlerts(db, T0)).toBe(1);
    expect((await alerts()).filter((r) => r.kind === "INFRA_CONNECTION_AUTH_ERROR").every((r) => r.severity === "URGENT")).toBe(true);
    // 정상 호출이 오류 뒤에 있으면 더는 알리지 않는다
    await recordConnectionResult(db, "gemini", "ok", undefined, new Date(T0.getTime() + 60_000));
    expect(await evaluateInfraAlerts(db, new Date(T0.getTime() + 120_000))).toBe(0);
  });

  it("알림은 최고관리자에게만 보이고, 정기 실행 목록에 들어 있다", async () => {
    diskPct = 85;
    await evaluateInfraAlerts(db, T0);
    const sup = await adminCtx("SUPER_ADMIN");
    const ops = await adminCtx("OPERATIONS");
    const seen = await listAdminAlerts(prisma, sup, {});
    expect(seen.ok && seen.items.map((i) => i.kind)).toEqual(["INFRA_DISK"]);
    const other = await listAdminAlerts(prisma, ops, {});
    expect(other.ok && other.items).toEqual([]);
    expect(SCHEDULED_JOBS.map((j) => j.name)).toContain("infra_alerts.evaluate");
    const job = SCHEDULED_JOBS.find((j) => j.name === "infra_alerts.evaluate")!;
    expect(await db.$transaction((tx) => job.run(tx, T0))).toBe(0);
  });
});
