import { NextResponse } from "next/server";
import { prisma } from "../../../../../lib/server/db";
import { createObsPairingChallenge } from "../../../../../lib/server/obs/pairing";
import { pairingJson, pairingRoute } from "../../../../../lib/server/obs/http";

export const POST = pairingRoute(false, async (req: Request) => {
  await pairingJson(req, []);
  return NextResponse.json(await createObsPairingChallenge(prisma), { status: 201 });
});
