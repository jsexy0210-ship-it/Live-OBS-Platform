import { NextResponse } from "next/server";
import { prisma } from "../../../../../../../../lib/server/db";
import { requireSeller } from "../../../../../../../../lib/server/authz/guards";
import { sessionToken } from "../../../../../../../../lib/server/http/route";
import { approveObsPairingChallenge } from "../../../../../../../../lib/server/obs/pairing";
import { pairingJson, pairingRoute } from "../../../../../../../../lib/server/obs/http";

export const POST = pairingRoute(true, async (req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { feature: "OVERLAY" });
  const body = await pairingJson(req, ["confirmationCode", "consentVersion", "installJobId", "replacesChallengeId"]);
  return NextResponse.json(await approveObsPairingChallenge(prisma, ctx, id, {
    confirmationCode: body.confirmationCode, consentVersion: body.consentVersion,
    installJobId: body.installJobId, replacesChallengeId: body.replacesChallengeId,
  }));
});
