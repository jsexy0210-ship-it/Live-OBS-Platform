import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../lib/server/http/route";
import { COUPON_MESSAGES } from "../../../../../lib/server/shop-coupons/rules";
import { deleteCoupon, setCouponActive, updateCoupon } from "../../../../../lib/server/shop-coupons/service";

// 쿠폰 수정(PUT, 전체 값)·발급 중지/다시 발급(PATCH { isActive })·삭제(발급 0장만). 다른 쇼핑몰의 id는 404.
// 대표자·적립금(MEMBER_POINTS) 직원만.
type Ctx = { params: Promise<{ couponId: string }> };

export const PUT = mutation(async (req: Request, { params }: Ctx) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await updateCoupon(prisma, ctx, (await params).couponId, await readJson(req), requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: COUPON_MESSAGES[r.reason] }, { status: r.reason === "code_taken" || r.reason === "method_locked" ? 409 : 400 });
  return NextResponse.json({ coupon: r.coupon });
});

export const PATCH = mutation(async (req: Request, { params }: Ctx) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const body = await readJson<{ isActive?: unknown }>(req);
  return NextResponse.json({ coupon: await setCouponActive(prisma, ctx, (await params).couponId, body.isActive, requestMeta(req)) });
});

export const DELETE = mutation(async (req: Request, { params }: Ctx) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "STORE_OPERATIONS" });
  const r = await deleteCoupon(prisma, ctx, (await params).couponId, requestMeta(req));
  if (!r.ok) return NextResponse.json({ error: r.reason, message: "발급한 쿠폰은 삭제할 수 없습니다. 발급을 중지하면 목록에서 「종료」로 남습니다." }, { status: 409 });
  return NextResponse.json({ ok: true });
});
