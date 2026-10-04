import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { readBodyLimited } from "../../../../../lib/server/branding/image";
import { prisma } from "../../../../../lib/server/db";
import { mutation, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { SHOP_IMAGE_MAX_BYTES, SHOP_IMAGE_MESSAGES, uploadShopImage } from "../../../../../lib/server/shop-content/image";

// 배너·팝업 이미지 올리기. 본문은 파일 바이트 그대로(Content-Type은 보지 않고 바이트로 형식 확인). 3MB를 넘으면 끝까지 받지 않고 413.
// 응답 { image: { id, width, height, url } }의 id를 배너·팝업 저장 때 보낸다. 권한은 대표자·SHOP_SETTINGS.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const bytes = await readBodyLimited(req, SHOP_IMAGE_MAX_BYTES);
  if (!bytes) return NextResponse.json({ error: "file_too_large", message: SHOP_IMAGE_MESSAGES.file_too_large }, { status: 413 });
  const r = await uploadShopImage(prisma, ctx, bytes, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: SHOP_IMAGE_MESSAGES[r.reason] }, { status: r.reason === "too_many_unused_images" ? 409 : 400 });
  const { id, width, height, version } = r.image;
  return NextResponse.json({ image: { id, width, height, url: `/api/seller/shop-content/images/${id}?v=${version}` } }, { status: 201 });
});
