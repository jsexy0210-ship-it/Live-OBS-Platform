import { NextResponse } from "next/server";
import { NOTIFICATION_PREF_MESSAGES, NOTIFICATION_PREF_STATUS, readNotificationPrefs, setNotificationPrefs } from "../../../../../../lib/server/buyers/notificationPrefs";
import { buyerScope } from "../../../../../../lib/server/buyers/scope";
import { prisma } from "../../../../../../lib/server/db";
import { mutation, noStore, readJson, requestMeta } from "../../../../../../lib/server/http/route";

// 구매자 본인의 알림 설정(SH-025, 로그인한 쇼핑몰 회원만, 잠긴 쇼핑몰이어도 연다).
// GET → { items: [{ kind, required, ad, message, email }], marketing }. message·email이 null이면 그 칸이 없는 것(광고성 줄의 알림톡·문자).
// PUT 본문 { prefs: { SHIPPING?: { message?, email? }, BROADCAST_START?: { email? }, DISCOUNT_RESTOCK?: { email? }, BENEFIT?: { email? } }, marketingVersion? }.
// BENEFIT.email = 마케팅 수신 동의(켤 때 marketingVersion 필수, 지금 버전이 아니면 409 consent_outdated). 필수 종류(ORDER·QUEUE)를 끄면 400 required_notification,
// 동의 없이 방송 시작·할인·재입고 이메일을 켜면 409 marketing_consent_required. 보낸 칸만 바꾼다. 응답은 저장 뒤 GET과 같다.
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const state = await readNotificationPrefs(prisma, b.scope);
  if (!state) return noStore(NextResponse.json({ error: "not_found" }, { status: 404 }));
  return noStore(NextResponse.json(state));
}

export const PUT = mutation(async (req: Request, { params }: { params: Promise<{ slug: string }> }) => {
  const b = await buyerScope(req, (await params).slug);
  if (!b.scope) return noStore(b.res);
  const r = await setNotificationPrefs(prisma, b.scope, await readJson(req), requestMeta(req));
  if (!r.ok) {
    if (r.reason === "not_found") return noStore(NextResponse.json({ error: r.reason }, { status: 404 }));
    return noStore(NextResponse.json({ error: r.reason, message: NOTIFICATION_PREF_MESSAGES[r.reason] }, { status: NOTIFICATION_PREF_STATUS[r.reason] }));
  }
  return noStore(NextResponse.json(r.state));
});
