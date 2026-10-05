import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { readBodyLimited } from "../../../../lib/server/branding/image";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, mutation, noStore, requestMeta, sessionToken } from "../../../../lib/server/http/route";
import { FAVICON_MAX_BYTES, FAVICON_MESSAGES, deleteShopFavicon, putShopFavicon, readShopFavicon } from "../../../../lib/server/seller-settings/shopFavicon";

// 쇼핑몰 파비콘(SA-060). 응답: { favicon: { source: "UPLOADED" | "LOGO" | null, version, sizes: [32,180,512], urls: { 32, 180, 512 } | null, uploaded: { width, byteSize } | null } }
// source: 올린 파비콘, 없으면 로고에서 자동 생성(LOGO), 둘 다 없으면 null(화면이 ONQ 기본 아이콘). 조회는 SHOP_SETTINGS 읽기.
// PUT(본문 = PNG 파일 바이트, 8비트·정사각형 64~1024px·256KB 이하)·DELETE는 대표자·SHOP_SETTINGS 직원만(그 밖 403). 넘는 크기는 끝까지 받지 않고 413.
export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
    return noStore(NextResponse.json({ favicon: await readShopFavicon(prisma, ctx) }));
  } catch (e) {
    return errorResponse(e);
  }
}

export const PUT = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const bytes = await readBodyLimited(req, FAVICON_MAX_BYTES);
  if (!bytes) return NextResponse.json({ error: "file_too_large", message: FAVICON_MESSAGES.file_too_large }, { status: 413 });
  const r = await putShopFavicon(prisma, ctx, bytes, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: FAVICON_MESSAGES[r.reason] }, { status: r.reason === "file_too_large" ? 413 : 400 });
  return NextResponse.json({ favicon: r.favicon });
});

export const DELETE = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await deleteShopFavicon(prisma, ctx, requestMeta(req));
  return NextResponse.json({ favicon: r.favicon });
});
