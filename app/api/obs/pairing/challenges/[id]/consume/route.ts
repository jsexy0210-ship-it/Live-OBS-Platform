import { NextResponse } from "next/server";
import { prisma } from "../../../../../../../lib/server/db";
import { consumeObsPairingChallenge } from "../../../../../../../lib/server/obs/pairing";
import { pairingJson, pairingProof, pairingRoute } from "../../../../../../../lib/server/obs/http";

export const POST = pairingRoute(false, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const body = await pairingJson(req, ["deviceId", "sellerId", "consentVersion"]);
  return NextResponse.json(await consumeObsPairingChallenge(prisma, id, pairingProof(req), {
    deviceId: body.deviceId, sellerId: body.sellerId, consentVersion: body.consentVersion,
  }));
});
