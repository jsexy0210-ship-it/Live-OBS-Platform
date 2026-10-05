import type { Prisma, PrismaClient } from "@prisma/client";
import { recordExternalCost } from "../automation/budget";
import { sealBillingKey, openBillingKey } from "../billing/secret";
import { sellerAccessFor } from "../billing/subscription";
import { OAUTH_STATE_KEEP_MS, REFRESH_AHEAD_MS, REFRESH_BUDGET_MS, WEBHOOK_RETENTION_DAYS } from "./config";
import { EXTERNAL_PROVIDER } from "./connect";
import { ExternalHttpError, type ExternalShopProvider } from "./provider";

// 외부 쇼핑몰 연동 정기 작업(lib/server/jobs/scheduler.ts에서 부른다). 모두 여러 인스턴스 중 하나만 돌고(작업 잠금), 반복해도 같은 결과다.

// 만료(또는 사용) 뒤 하루 지난 OAuth 시작 기록 삭제
export async function purgeExpiredOAuthStates(tx: Prisma.TransactionClient, now: Date): Promise<number> {
  const r = await tx.externalOAuthState.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - OAUTH_STATE_KEEP_MS) } } });
  return r.count;
}

// 받은 지 30일 지난 웹훅 원본 삭제(개인정보가 들어 있을 수 있어 기간이 지나면 처리 여부와 관계없이 지운다)
export async function purgeOldWebhookEvents(tx: Prisma.TransactionClient, now: Date): Promise<number> {
  const r = await tx.externalWebhookEvent.deleteMany({ where: { receivedAt: { lt: new Date(now.getTime() - WEBHOOK_RETENTION_DAYS * 86_400_000) } } });
  return r.count;
}

// 갱신 토큰이 곧 만료되는(또는 접근 토큰이 이미 만료된) 연결의 토큰을 새로 받는다. 갱신 토큰은 갱신할 때마다 바뀌므로 둘 다 새 값으로 저장한다.
// 이미 무효(400·401)이거나 갱신 토큰이 만료됐으면 「다시 연결 필요」로 바꾸고 토큰을 지운다. 시간 초과·5xx는 상태를 두고 다음 번에 다시 한다.
// 결제 유예가 끝나 잠긴 파트너스는 쇼핑몰 API를 부르지 않는다. 연동 키가 없으면(provider null) 아무것도 하지 않는다.
export async function refreshDueTokens(db: PrismaClient, provider: ExternalShopProvider | null, now: Date, budgetMs = REFRESH_BUDGET_MS): Promise<number> {
  if (!provider) return 0;
  const started = Date.now();
  const due = await db.externalShopConnection.findMany({
    where: {
      status: "CONNECTED",
      refreshTokenCipher: { not: null },
      OR: [{ accessExpiresAt: null }, { accessExpiresAt: { lt: now } }, { refreshExpiresAt: { lt: new Date(now.getTime() + REFRESH_AHEAD_MS) } }],
    },
    orderBy: { updatedAt: "asc" },
    take: 50,
  });
  let n = 0;
  for (const c of due) {
    if (Date.now() - started > budgetMs) break;
    if ((await sellerAccessFor(db, c.sellerId)) === "expired") continue;
    if (c.refreshExpiresAt && c.refreshExpiresAt <= now) {
      await db.externalShopConnection.update({ where: { id: c.id }, data: { status: "REAUTH_REQUIRED", accessTokenCipher: null, refreshTokenCipher: null, accessExpiresAt: null, refreshExpiresAt: null } });
      n++;
      continue;
    }
    try {
      const t = await provider.refresh(c.shopKey, openBillingKey(c.refreshTokenCipher!, c.sellerId));
      await recordExternalCost(db, { provider: EXTERNAL_PROVIDER, purpose: "oauth_refresh", costWon: 0 });
      await db.externalShopConnection.update({
        where: { id: c.id },
        data: {
          accessTokenCipher: sealBillingKey(t.accessToken, c.sellerId),
          refreshTokenCipher: sealBillingKey(t.refreshToken, c.sellerId),
          accessExpiresAt: t.accessExpiresAt,
          refreshExpiresAt: t.refreshExpiresAt,
          scopes: t.scopes ?? c.scopes,
        },
      });
      n++;
    } catch (e) {
      if (e instanceof ExternalHttpError && (e.status === 400 || e.status === 401)) {
        await db.externalShopConnection.update({ where: { id: c.id }, data: { status: "REAUTH_REQUIRED", accessTokenCipher: null, refreshTokenCipher: null, accessExpiresAt: null, refreshExpiresAt: null } });
        n++;
      }
      // 그 밖의 오류는 상태를 두고 다음 번에 다시 한다(토큰 원문·응답 본문은 기록하지 않는다)
    }
  }
  return n;
}
