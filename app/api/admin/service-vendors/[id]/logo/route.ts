import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { VENDOR_LOGO_MAX_BYTES, readBodyLimited } from "../../../../../../lib/server/branding/image";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, mutation, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";
import { VENDOR_MESSAGES, VENDOR_STATUS, readServiceVendorLogo, removeServiceVendorLogo, setServiceVendorLogo } from "../../../../../../lib/server/admin/serviceVendors";

type Ctx = { params: Promise<{ id: string }> };

// 업체 로고 보기(마스터 관리자 화면용, 로그인 필요). 주소의 ?v=는 파일 해시라 바뀌면 다시 받는다.
export async function GET(req: Request, ctx: Ctx) {
  try {
    await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    const { id } = await ctx.params;
    const logo = await readServiceVendorLogo(prisma, id);
    if (!logo) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return new NextResponse(new Uint8Array(logo.data), {
      headers: { "content-type": logo.type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=86400", "content-security-policy": "default-src 'none'; sandbox" },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

// 로고 올리기(PNG, 256KB까지, 가로·세로 16~600px). 본문은 파일 바이트 그대로. 형식은 파일 내용으로 확인한다. 최고관리자·운영.
export const PUT = mutation(async (req: Request, ctx: Ctx) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "vendor.manage");
  const { id } = await ctx.params;
  const data = await readBodyLimited(req, VENDOR_LOGO_MAX_BYTES);
  if (!data) return NextResponse.json({ error: "file_too_large", message: VENDOR_MESSAGES.file_too_large }, { status: 413 });
  const r = await setServiceVendorLogo(prisma, admin, id, data, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: VENDOR_MESSAGES[r.reason] }, { status: VENDOR_STATUS[r.reason] });
  return NextResponse.json({ logoUrl: r.logoUrl });
});

// 로고 지우기(화면은 업체 이름 첫 글자를 보여 준다)
export const DELETE = mutation(async (req: Request, ctx: Ctx) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "vendor.manage");
  const { id } = await ctx.params;
  const r = await removeServiceVendorLogo(prisma, admin, id, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: VENDOR_MESSAGES[r.reason] }, { status: VENDOR_STATUS[r.reason] });
  return NextResponse.json({ logoUrl: null });
});
