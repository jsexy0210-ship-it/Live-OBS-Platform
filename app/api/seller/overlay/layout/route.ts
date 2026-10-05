import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { getSellerLayout, parseAspect, saveLayout } from "../../../../../lib/server/overlay/layout";

// 오버레이 레이아웃(SA-051). ?aspect=9x16|16x9. OVERLAY_EDIT. 저장한 적 없으면 기본 템플릿(version 0, isDefault).
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    const aspect = parseAspect(new URL(req.url).searchParams.get("aspect"));
    if (!aspect) return NextResponse.json({ error: "invalid_aspect" }, { status: 400 });
    return NextResponse.json(await getSellerLayout(prisma, ctx, aspect), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

// 저장(전체 교체). 본문 { aspect, widgets, expectedVersion }. 다른 창에서 먼저 저장했으면 409 version_conflict(지금 version을 준다).
export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const body = await readJson<{ aspect?: unknown; widgets?: unknown; expectedVersion?: unknown }>(req);
  const r = await saveLayout(prisma, ctx, { aspect: body.aspect, widgets: body.widgets, expectedVersion: body.expectedVersion }, requestMeta(req));
  if (!r.ok) {
    if (r.reason === "version_conflict") return NextResponse.json({ error: r.reason, message: "다른 곳에서 먼저 저장했습니다. 새로 불러온 뒤 다시 저장해 주십시오", currentVersion: r.current }, { status: 409 });
    return NextResponse.json({ error: "invalid_layout", message: "위젯 위치·크기·속성 값을 확인해 주십시오" }, { status: 400 });
  }
  return NextResponse.json(r.layout);
});
