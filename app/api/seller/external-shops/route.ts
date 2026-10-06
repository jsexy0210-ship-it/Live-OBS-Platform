import { NextResponse } from "next/server";
import { requireSeller } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { listConnections, startConnect, startReconnect } from "../../../../lib/server/external/connect";
import { sellerCan } from "../../../../lib/server/authz/permissions";
import { isJobId } from "../../../../lib/server/automation/ids";
import { externalConfig } from "../../../../lib/server/external/config";
import { externalProvider } from "../../../../lib/server/external/provider";
import { errorResponse, mutation, noStore, readJson, sessionToken } from "../../../../lib/server/http/route";

// 외부 쇼핑몰 연동 목록(SA-006, 연결마다 lastEventAt·lastEventKind)과 연결 시작. 대표자 또는 쇼핑몰 설정 권한 직원만, 「외부 연동」 권한이 있는 요금제만.
// 플랫폼 이름은 응답·오류에 쓰지 않는다. 연동 키가 없으면 enabled:false(화면은 「준비 중」), 연결 시작은 503.
const MESSAGES = {
  integration_disabled: "외부 쇼핑몰 연결을 준비하고 있습니다. 조금만 기다려 주십시오",
  shop_not_supported: "아직 연결할 수 없는 쇼핑몰입니다",
  already_connected: "이미 다른 파트너스에 연결된 쇼핑몰입니다",
} as const;
const STATUS = { integration_disabled: 503, shop_not_supported: 409, already_connected: 409 } as const;

export async function GET(req: Request) {
  try {
    const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "EXTERNAL_INTEGRATION" });
    return noStore(NextResponse.json({ enabled: externalConfig().enabled, canManage: !ctx.readOnly && sellerCan(ctx, "SHOP_SETTINGS"), connections: await listConnections(prisma, ctx) }));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}

export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "EXTERNAL_INTEGRATION" });
  const body = await readJson<{ shopUrl: unknown; connectionId: unknown }>(req);
  // connectionId가 있으면 그 연결을 다시 연결, 없으면 shopUrl로 새 연결
  if (body.connectionId !== undefined && !isJobId(body.connectionId)) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  const r = body.connectionId ? await startReconnect(prisma, externalProvider(), ctx, body.connectionId as string) : await startConnect(prisma, externalProvider(), ctx, body.shopUrl);
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason, message: MESSAGES[r.reason] }, { status: STATUS[r.reason] }));
  return noStore(NextResponse.json({ authorizeUrl: r.authorizeUrl }));
});
