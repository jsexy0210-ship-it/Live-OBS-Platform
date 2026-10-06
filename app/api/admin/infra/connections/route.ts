import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { errorResponse, noStore, sessionToken } from "../../../../../lib/server/http/route";
import { listConnections } from "../../../../../lib/server/ops/connections";

// 외부 연결 만료·상태(MA-120, 최고관리자만). 키 값은 없다.
// → { checkedAt, connections: [{ key, name, purpose, expiresOn(YYYY-MM-DD KST)|null, daysLeft|null, lastOkAt, lastAuthErrorAt, lastAuthErrorCode, status: ok|expiring|auth_error|not_connected, version }] }
export async function GET(req: Request) {
  try {
    const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "infra.manage");
    return noStore(NextResponse.json(await listConnections(prisma, admin)));
  } catch (e) {
    return noStore(errorResponse(e));
  }
}
