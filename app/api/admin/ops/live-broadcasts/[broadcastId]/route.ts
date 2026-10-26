import { NextResponse } from "next/server";
import { listLiveBroadcasts } from "../../../../../../lib/server/admin/ops";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../lib/server/http/route";
export async function GET(req: Request, { params }: { params: Promise<{ broadcastId: string }> }) {
 try {
  const admin = await requireAdmin(prisma, sessionToken(req,"admin"),"platform.read");
  const { broadcastId } = await params;
  if (!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(broadcastId)) return noStore(NextResponse.json({error:"not_found"},{status:404}));
  const data = await listLiveBroadcasts(prisma,admin,broadcastId);
  const broadcast = data.items[0];
  return noStore(broadcast ? NextResponse.json({broadcast}) : NextResponse.json({error:"not_found"},{status:404}));
 } catch(e) { return noStore(errorResponse(e)); }
}
