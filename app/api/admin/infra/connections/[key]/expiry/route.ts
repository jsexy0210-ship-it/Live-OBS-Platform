import { NextResponse } from "next/server";
import { requireAdmin } from "../../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta, sessionToken } from "../../../../../../../lib/server/http/route";
import { updateConnectionExpiry } from "../../../../../../../lib/server/ops/connections";

// 외부 연결 만료일 입력(최고관리자만, 로그 추적 admin.infra.connection_expiry_update). 본문 { expiresOn: "YYYY-MM-DD" | null, expectedVersion }. null이면 지움.
// → 200 { expiresOn, version } | 400 invalid_input | 404 not_found | 409 version_conflict
export const PUT = mutation(async (req: Request, { params }: { params: Promise<{ key: string }> }) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "infra.manage");
  const { key } = await params;
  const body = await readJson<{ expiresOn: unknown; expectedVersion: unknown }>(req);
  const r = await updateConnectionExpiry(prisma, admin, key.slice(0, 60), body, requestMeta(req));
  if (!r.ok) return noStore(NextResponse.json({ error: r.reason }, { status: r.reason === "not_found" ? 404 : r.reason === "version_conflict" ? 409 : 400 }));
  return noStore(NextResponse.json({ expiresOn: r.expiresOn, version: r.version }));
});
