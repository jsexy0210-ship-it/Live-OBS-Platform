import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { VENDOR_MESSAGES, VENDOR_STATUS, isVendorCategory, updateServiceVendorCategory } from "../../../../../lib/server/admin/serviceVendors";

// 분야 설정(최고관리자·운영). 본문 중 보낸 키만 바꾼다: weights({평가 항목: 0~100 정수} 모든 항목, 합 > 0), recommendedVendorId(「추천」 1개, null이면 해제),
// selectedVendorId(「선택된 업체」 1개, null이면 해제). 추천·선택은 같은 분야의 사용 중인 업체만. 응답: { category } (목록의 분야 한 칸과 같은 모양).
export const PUT = mutation(async (req: Request, ctx: { params: Promise<{ category: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "vendor.manage");
  const { category } = await ctx.params;
  if (!isVendorCategory(category)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await updateServiceVendorCategory(prisma, admin, category, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: VENDOR_MESSAGES[r.reason] }, { status: VENDOR_STATUS[r.reason] });
  return NextResponse.json({ category: r.category });
});
