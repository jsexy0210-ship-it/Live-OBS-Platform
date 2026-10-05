import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { disconnect } from "../../../../../lib/server/external/connect";
import { externalProvider } from "../../../../../lib/server/external/provider";
import { isJobId } from "../../../../../lib/server/automation/ids";
import { mutation, noStore, sessionToken } from "../../../../../lib/server/http/route";

// 연결 해제(SA-006). 쇼핑몰 쪽 토큰 철회를 요청해 성공하면 해제됨, 실패하면 「해제 대기」(철회 재시도). 대표자 또는 쇼핑몰 설정 권한 직원만.
export const DELETE = mutation(async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "EXTERNAL_INTEGRATION" });
  const { id } = await params;
  if (!isJobId(id)) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  return noStore(NextResponse.json(await disconnect(prisma, externalProvider(), ctx, id)));
});
