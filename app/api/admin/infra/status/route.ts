import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { infraStatus } from "../../../../../lib/server/ops/infra";

// 인프라 용량 실시간 확인(마스터 관리자 최고관리자만, system.manage). ?hours=N(기본 48, 최대 840)은 시간별 스냅숏 범위.
// → { checkedAt, thresholds, current, signals[], snapshots[] } (못 잰 값은 null, 비밀값 없음)
export async function GET(req: Request) {
  try {
    await requireAdmin(prisma, sessionToken(req, "admin"), "system.manage");
    const h = Number(new URL(req.url).searchParams.get("hours"));
    return noStore(NextResponse.json(await infraStatus(prisma, { snapshotHours: Number.isFinite(h) && h > 0 ? h : undefined })));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
