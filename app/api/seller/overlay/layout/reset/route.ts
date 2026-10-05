import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { resetLayout } from "../../../../../../lib/server/overlay/layout";

// 템플릿으로 초기화. 본문 { aspect, template(기본 템플릿 키 또는 내 템플릿 id), expectedVersion }.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const body = await readJson<{ aspect?: unknown; template?: unknown; expectedVersion?: unknown }>(req);
  const r = await resetLayout(prisma, ctx, { aspect: body.aspect, template: body.template, expectedVersion: body.expectedVersion }, requestMeta(req));
  if (!r.ok) {
    if (r.reason === "version_conflict") return NextResponse.json({ error: r.reason, message: "다른 곳에서 먼저 저장했습니다. 새로 불러온 뒤 다시 시도해 주십시오", currentVersion: r.current }, { status: 409 });
    if (r.reason === "template_not_found") return NextResponse.json({ error: r.reason, message: "템플릿을 찾을 수 없습니다" }, { status: 404 });
    return NextResponse.json({ error: "invalid_layout", message: "입력한 값을 확인해 주십시오" }, { status: 400 });
  }
  return NextResponse.json(r.layout);
});
