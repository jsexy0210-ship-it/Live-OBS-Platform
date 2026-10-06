import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { updateInfraPrices } from "../../../../../lib/server/ops/infraCost";

// 인프라 단가 입력(최고관리자만, 로그 추적 admin.infra.price_update). 본문 { expectedVersion, prices: { 키: 숫자 | null } }.
// 키: serverMonthlyWon·diskMonthlyWon·publicIpMonthlyWon·storageWonPerGbMonth·trafficWonPerGb·mailWonEach·smsWonEach·alimtalkWonEach(원, 정수), pgFeeRatePct(%, 소수 둘째 자리). null이면 지움.
// → 200 { prices, version } | 400 invalid_input·invalid_price | 409 version_conflict
export const PUT = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "infra.manage");
  const body = await readJson<{ prices: unknown; expectedVersion: unknown }>(req);
  const r = await updateInfraPrices(prisma, admin, body, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason }, { status: r.reason === "version_conflict" ? 409 : 400 });
  return NextResponse.json({ prices: r.prices, version: r.version });
});
