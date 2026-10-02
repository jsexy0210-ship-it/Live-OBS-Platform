import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../lib/server/authz/guards";
import { prisma } from "../../../../lib/server/db";
import { errorResponse, sessionToken } from "../../../../lib/server/http/route";

export async function GET(req: Request) {
  try {
    const { admin } = await requireAdmin(prisma, sessionToken(req, "admin"), "platform.read");
    return NextResponse.json({ id: admin.id, name: admin.name, email: admin.email, role: admin.role });
  } catch (e) {
    return errorResponse(e);
  }
}
