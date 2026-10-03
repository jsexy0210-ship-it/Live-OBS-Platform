import { NextResponse } from "next/server";
import { deleteAddress, updateAddress } from "../../../../../../lib/server/buyers/addresses";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson } from "../../../../../../lib/server/http/route";
import { orderErrorBody } from "../../../../../../lib/server/orders/messages";

type Ctx = { params: Promise<{ slug: string; addressId: string }> };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 없는 배송지와 다른 구매자의 배송지는 같은 404로 답한다
const notFound = () => noStore(NextResponse.json(orderErrorBody("address_not_found"), { status: 404 }));
const status = (reason: string) => (reason === "address_not_found" ? 404 : reason === "duplicate_address" ? 409 : 400);

// 수정. 보낸 항목만 바꾼다. isDefault: true면 기본 배송지로 지정.
export const PATCH = mutation(async (req: Request, { params }: Ctx) => {
  const { slug, addressId } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  if (!UUID.test(addressId)) return notFound();
  const r = await updateAddress(prisma, b.scope, addressId, await readJson(req));
  if (!r.ok) return noStore(NextResponse.json(orderErrorBody(r.reason), { status: status(r.reason) }));
  return noStore(NextResponse.json({ address: r.value }));
});

// 삭제. 기본 배송지를 지우면 가장 최근에 저장한 배송지가 기본이 된다.
export const DELETE = mutation(async (req: Request, { params }: Ctx) => {
  const { slug, addressId } = await params;
  const b = await buyerScope(req, slug);
  if (!b.scope) return noStore(b.res);
  if (!UUID.test(addressId)) return notFound();
  const r = await deleteAddress(prisma, b.scope, addressId);
  if (!r.ok) return notFound();
  return noStore(NextResponse.json({ ok: true }));
});
