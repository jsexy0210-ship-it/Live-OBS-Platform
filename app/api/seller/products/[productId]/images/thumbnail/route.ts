import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../../../lib/server/http/route";
import { setProductThumbnail } from "../../../../../../../lib/server/products/images";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const THUMBNAIL_MESSAGE = "썸네일로 지정할 이미지를 다시 확인해 주십시오";

// 썸네일 지정·해제(PRODUCT_MANAGE). 본문 { imageId: 이 상품의 상품 사진 id | null }. null이면 지정을 풀어 첫 번째 사진이 썸네일.
// 응답 { images: [{ id, url, sortOrder, width, height, isThumbnail }] }(상품 사진 전부). 형식이 틀리면 400 invalid_thumbnail, 이 상품 사진이 아니면 404.
// 썸네일은 목록·카드·상세·방송 상품·진열 등 상품 대표 이미지가 쓰이는 모든 응답에 쓰인다.
export const PUT = mutation(async (req: Request, { params }: { params: Promise<{ productId: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const { productId } = await params;
  if (!UUID.test(productId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await setProductThumbnail(prisma, ctx, productId, await readJson(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: THUMBNAIL_MESSAGE }, { status: 400 });
  return NextResponse.json({ images: r.images });
});
