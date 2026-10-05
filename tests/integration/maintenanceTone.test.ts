import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "../../lib/server/db";
import { clearMaintenanceCache } from "../../lib/server/maintenance/service";
import { proxy } from "../../proxy";
import { db, resetDb } from "./helpers";

// 점검 중 화면 말투 분기: proxy가 /seller 주소는 /maintenance?area=partners(합니다체)로, /shop 주소는 구역 값 없이 /maintenance(해요체)로 돌린다.
// 마스터 관리자(/admin)·공개 화면·오버레이는 점검 중에도 막지 않으므로 돌리지 않는다.
beforeEach(async () => {
  await resetDb();
  clearMaintenanceCache();
});
afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

const BASE = "http://localhost:3000";
async function rewriteOf(path: string) {
  const res = await proxy(new NextRequest(BASE + path));
  const to = res.headers.get("x-middleware-rewrite");
  return to ? new URL(to).pathname + new URL(to).search : res.headers.get("x-middleware-next") === "1" ? "pass" : `status ${res.status}`;
}

describe("점검 중 화면 구역", () => {
  it("파트너스 화면은 partners 구역, 구매자 쇼핑몰은 구역 없음, 막지 않는 주소는 그대로 통과한다", async () => {
    await db.platformMaintenance.upsert({ where: { id: 1 }, create: { id: 1, enabled: true, message: "점검" }, update: { enabled: true, message: "점검" } });
    for (const p of ["/seller", "/seller/login", "/seller/orders/abc", "/seller/settings/legal"]) expect(await rewriteOf(p), p).toBe("/maintenance?area=partners");
    for (const p of ["/shop/demo", "/shop/demo/products/x", "/shop/demo/terms"]) expect(await rewriteOf(p), p).toBe("/maintenance");
    // 이름이 비슷한 다른 주소는 파트너스 구역이 아니다(/sellers 는 막는 목록에도 없음)
    expect(await rewriteOf("/sellers")).toBe("pass");
  });

  it("점검이 꺼져 있으면 어느 주소도 돌리지 않는다", async () => {
    await db.platformMaintenance.upsert({ where: { id: 1 }, create: { id: 1, enabled: false }, update: { enabled: false } });
    for (const p of ["/seller/login", "/shop/demo"]) expect(await rewriteOf(p), p).toBe("pass");
  });
});
