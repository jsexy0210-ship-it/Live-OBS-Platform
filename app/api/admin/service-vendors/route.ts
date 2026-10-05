import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { errorResponse, mutation, readJson, requestMeta, sessionToken } from "../../../../lib/server/http/route";
import { prisma } from "../../../../lib/server/db";
import { VENDOR_MESSAGES, VENDOR_STATUS, createServiceVendor, isVendorCategory, listServiceVendors } from "../../../../lib/server/admin/serviceVendors";

// 외부 서비스 업체 목록(설정 > 외부 서비스 연동). ?category=PG|SHIPPING|TRACKING(빼면 세 분야 모두). 마스터 관리자 누구나 조회.
// 응답: { categories: [{ category, criteria:[{key,weight}], featureKeys, recommendedVendorId, selectedVendorId, vendors:[{ id, name, features, referenceFee, memo, ratings, ratedCount, score, active, logoUrl, recommended, selected }] }] }
export async function GET(req: Request) {
  try {
    await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const c = new URL(req.url).searchParams.get("category");
    if (c !== null && !isVendorCategory(c)) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    return NextResponse.json(await listServiceVendors(prisma, c ?? undefined), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return errorResponse(e);
  }
}

// 업체 등록(최고관리자·운영). 본문 { category, name, features?, referenceFee?, memo?, ratings?, active? }
export const POST = mutation(async (req: Request) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "vendor.manage");
  const r = await createServiceVendor(prisma, admin, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: VENDOR_MESSAGES[r.reason] }, { status: VENDOR_STATUS[r.reason] });
  return NextResponse.json({ vendor: r.vendor }, { status: 201 });
});
