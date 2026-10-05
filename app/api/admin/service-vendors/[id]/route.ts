import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { VENDOR_MESSAGES, VENDOR_STATUS, updateServiceVendor } from "../../../../../lib/server/admin/serviceVendors";

// 업체 수정(최고관리자·운영). 본문: name, features, referenceFee, memo, ratings({항목: 0~10, null이면 그 항목 지움}), active 중 보낸 키만.
// 추천·선택 중인 업체를 사용 안 함으로 바꾸면 409 vendor_in_use.
export const PATCH = mutation(async (req: Request, ctx: { params: Promise<{ id: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "vendor.manage");
  const { id } = await ctx.params;
  const r = await updateServiceVendor(prisma, admin, id, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: VENDOR_MESSAGES[r.reason] }, { status: VENDOR_STATUS[r.reason] });
  return NextResponse.json({ vendor: r.vendor });
});
