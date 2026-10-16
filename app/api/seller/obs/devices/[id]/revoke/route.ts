import { NextResponse } from "next/server";
import { prisma } from "../../../../../../../lib/server/db";
import { requireSeller } from "../../../../../../../lib/server/authz/guards";
import { sessionToken } from "../../../../../../../lib/server/http/route";
import { revokeObsDevice } from "../../../../../../../lib/server/obs/pairing";
import { pairingJson, pairingRoute } from "../../../../../../../lib/server/obs/http";

export const POST = pairingRoute(true, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  // 만료/미결제 뒤에도 자신의 기기 인증은 회수할 수 있다.
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, allowSuspended: true, feature: "BILLING" });
  const body = await pairingJson(req, ["generation"]);
  return NextResponse.json(await revokeObsDevice(prisma, ctx, id, body.generation));
});
