import { NextResponse } from "next/server";
import { ADMIN_ASSISTANT_MESSAGES, deleteAssistantDoc, updateAssistantDoc } from "../../../../../../lib/server/assistant/admin";
import { requireAdmin } from "../../../../../../lib/server/authz/guards";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, readJson, requestMeta, sessionToken } from "../../../../../../lib/server/http/route";

type Ctx = { params: Promise<{ docId: string }> };
const conflict = (currentVersion: number) => NextResponse.json({ error: "version_conflict", message: ADMIN_ASSISTANT_MESSAGES.version_conflict, currentVersion }, { status: 409 });

// 고치기(전체 값). 최고관리자·CS. 본문 { title, body, published?, expectedVersion }. version이 다르면 409.
export const PUT = mutation(async (req: Request, { params }: Ctx) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "support.manage");
  const r = await updateAssistantDoc(prisma, admin, (await params).docId, await readJson(req), requestMeta(req));
  if (!r.ok) return "currentVersion" in r ? conflict(r.currentVersion as number) : NextResponse.json({ error: r.reason, message: ADMIN_ASSISTANT_MESSAGES[r.reason] }, { status: 400 });
  return NextResponse.json({ doc: r.doc });
});

// 지우기. 최고관리자·CS. ?expectedVersion=
export const DELETE = mutation(async (req: Request, { params }: Ctx) => {
  const admin = await requireAdmin(prisma, sessionToken(req, "admin"), "support.manage");
  const v = new URL(req.url).searchParams.get("expectedVersion");
  const r = await deleteAssistantDoc(prisma, admin, (await params).docId, v !== null && /^\d+$/.test(v) ? Number(v) : null, requestMeta(req));
  if (!r.ok) return conflict(r.currentVersion);
  return NextResponse.json({ ok: true });
});
