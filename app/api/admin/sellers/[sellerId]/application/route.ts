import { NextResponse } from "next/server";
import { getApplicationReview } from "../../../../../../lib/server/sellers/applications";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../../lib/server/http/route";
export async function GET(req: Request, { params }: { params: Promise<{ sellerId: string }> }) {
 try { const admin = await requireAdmin(prisma, sessionToken(req,"admin"),"platform.read"); const data = await getApplicationReview(prisma,admin,(await params).sellerId); return noStore(data ? NextResponse.json(data) : NextResponse.json({error:"not_found"},{status:404})); }
 catch(e) { return noStore(errorResponse(e)); }
}
