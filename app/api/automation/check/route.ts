import { NextResponse } from "next/server";
import { budgetOpen, PLANNER_PROVIDER } from "../../../../lib/server/automation/budget";
import { SHOP_NOT_SUPPORTED_MESSAGE, supportedPlaybookFor } from "../../../../lib/server/automation/purchase";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { requireSellerPermission } from "../../../../lib/server/tenant/context";
import { prisma } from "../../../../lib/server/db";
import { mutation, noStore, readJson, sessionToken } from "../../../../lib/server/http/route";

// 결제 전 쇼핑몰 주소 확인(SA-150 「확인하기」). 지원 목록(연습으로 검증된 작업서)에 있는 쇼핑몰인지와 이번 달 접수 가능 여부만 돌려준다. 결제·작업은 만들지 않는다. 구매와 같이 대표자 전용·오버레이 이상 요금제.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  requireSellerPermission(ctx, "SUBSCRIPTION_MANAGE"); // 구매와 같은 대표자 전용(자동 연결 구매 화면의 일부)
  const body = await readJson<{ shopUrl: unknown }>(req);
  if (!(await supportedPlaybookFor(prisma, body.shopUrl))) return noStore(NextResponse.json({ supported: false, message: SHOP_NOT_SUPPORTED_MESSAGE }));
  if (!(await budgetOpen(prisma, PLANNER_PROVIDER))) return noStore(NextResponse.json({ supported: true, paused: true }));
  return noStore(NextResponse.json({ supported: true, paused: false }));
});
