import { NextResponse } from "next/server";
import { requireSeller } from "../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../lib/server/db";
import { mutation, readJson, sessionToken } from "../../../../../lib/server/http/route";
import { consentMessageFee } from "../../../../../lib/server/messaging/settings";

// 발송 비용 안내 동의(첫 충전 전). 본문 { version }(지금 서식 버전). 이미 동의했으면 그 기록을 그대로 준다.
export const POST = mutation(async (req: Request) => {
  const ctx = await requireSeller(prisma, sessionToken(req, "seller"), undefined, { allowUnpaid: true, feature: "BILLING" });
  const body = await readJson<{ version?: unknown }>(req);
  const r = await consentMessageFee(prisma, ctx, { version: body.version });
  if (!r.ok) return NextResponse.json({ error: "notice_version_mismatch", message: "안내 내용이 바뀌었습니다. 새로 고친 뒤 다시 확인해 주십시오" }, { status: 409 });
  return NextResponse.json(r.consent);
});
