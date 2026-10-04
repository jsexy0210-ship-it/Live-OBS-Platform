import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { createTemplate, listTemplates, parseAspect } from "../../../../../lib/server/overlay/layout";

// 템플릿 목록: 기본 템플릿 3종 + 내 템플릿. ?aspect=9x16|16x9. OVERLAY_EDIT.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
    const aspect = parseAspect(new URL(req.url).searchParams.get("aspect"));
    if (!aspect) return NextResponse.json({ error: "invalid_aspect" }, { status: 400 });
    return NextResponse.json(await listTemplates(prisma, ctx, aspect), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

// 내 템플릿으로 저장. 본문 { name(1~30자), aspect, widgets }. 판매자당 20개까지(넘으면 409 too_many_templates).
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const body = await readJson<{ name?: unknown; aspect?: unknown; widgets?: unknown }>(req);
  const r = await createTemplate(prisma, ctx, { name: body.name, aspect: body.aspect, widgets: body.widgets }, requestMeta(req));
  if (!r.ok) {
    if (r.reason === "too_many_templates") return NextResponse.json({ error: r.reason, message: "내 템플릿은 20개까지 저장할 수 있습니다. 쓰지 않는 템플릿을 지운 뒤 다시 저장해 주십시오" }, { status: 409 });
    return NextResponse.json({ error: r.reason, message: "템플릿 이름(30자 이내)과 위젯 값을 확인해 주십시오" }, { status: 400 });
  }
  return NextResponse.json(r.template, { status: 201 });
});
