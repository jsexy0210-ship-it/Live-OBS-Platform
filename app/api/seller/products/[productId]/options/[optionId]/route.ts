import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../../lib/server/orders/messages";
import { deleteOption, updateOption, type ProductFailure } from "../../../../../../../lib/server/products/manage";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = { params: Promise<{ productId: string; optionId: string }> };
const status = (reason: ProductFailure) => (reason === "stock_conflict" ? 409 : 400);

// 옵션 수정. 본문: 바꿀 항목만 { name?, priceDelta?, sku?, sortOrder? }, 재고는 { stock, expectedStock(화면이 본 재고) } 함께.
export const PATCH = mutation(async (req: Request, { params }: Params) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const { productId, optionId } = await params;
  if (!UUID.test(productId) || !UUID.test(optionId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await updateOption(prisma, ctx, productId, optionId, await readJson(req));
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason), { status: status(r.reason) });
  return NextResponse.json(r.value);
});

// 소프트 삭제. 판매 중 상품의 마지막 옵션은 400 no_sellable_option.
export const DELETE = mutation(async (req: Request, { params }: Params) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"));
  const { productId, optionId } = await params;
  if (!UUID.test(productId) || !UUID.test(optionId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const r = await deleteOption(prisma, ctx, productId, optionId);
  if (!r.ok) return NextResponse.json(orderErrorBody(r.reason), { status: status(r.reason) });
  return NextResponse.json(r.value);
});
