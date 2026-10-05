import { createHash, randomBytes } from "node:crypto";
import { Prisma, type ExternalShopConnection, type PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { notFound } from "../authz/errors";
import { openBillingKey, sealBillingKey } from "../billing/secret";
import { requireSellerPermission, type TenantContext } from "../tenant/context";
import { recordExternalCost } from "../automation/budget";
import { OAUTH_STATE_TTL_MS } from "./config";
import { shopKeyOf, type ExternalShopProvider } from "./provider";

// 연결·재연결·해제는 대표자 또는 「쇼핑몰 설정」(SHOP_SETTINGS) 직원만. 조회도 같은 권한(토큰·웹훅 값은 어디에도 내보내지 않는다).
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const isUnique = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
export const EXTERNAL_PROVIDER = "external_shop";

export type StartResult = { ok: true; authorizeUrl: string } | { ok: false; reason: "integration_disabled" | "shop_not_supported" | "already_connected" };

// 연결 시작: 1회용·만료 state를 만들고 인증 주소를 돌려준다. 이미 다른 파트너스에 붙은 쇼핑몰은 시작 단계에서 막는다.
export async function startConnect(db: PrismaClient, provider: ExternalShopProvider | null, ctx: TenantContext, shopUrl: unknown): Promise<StartResult> {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  if (!provider) return { ok: false, reason: "integration_disabled" };
  const shopKey = shopKeyOf(shopUrl);
  if (!shopKey) return { ok: false, reason: "shop_not_supported" };
  return beginOAuth(db, provider, ctx, shopKey);
}

// 다시 연결: 이미 있는 연결의 쇼핑몰로 연결을 새로 시작한다(주소를 다시 받지 않는다). 다시 연결 필요·연결됨 상태만. 다른 파트너스의 연결은 404.
export async function startReconnect(db: PrismaClient, provider: ExternalShopProvider | null, ctx: TenantContext, connectionId: string): Promise<StartResult> {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const c = await db.externalShopConnection.findFirst({ where: { id: connectionId, sellerId: ctx.sellerId, status: { in: ["CONNECTED", "REAUTH_REQUIRED"] } } });
  if (!c) throw notFound();
  if (!provider) return { ok: false, reason: "integration_disabled" };
  return beginOAuth(db, provider, ctx, c.shopKey);
}

async function beginOAuth(db: PrismaClient, provider: ExternalShopProvider, ctx: TenantContext, shopKey: string): Promise<StartResult> {
  const taken = await db.externalShopConnection.findFirst({ where: { shopKey, status: { not: "DISCONNECTED" }, NOT: { sellerId: ctx.sellerId } }, select: { id: true } });
  if (taken) return { ok: false, reason: "already_connected" };
  const state = randomBytes(32).toString("base64url");
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  await db.externalOAuthState.create({
    data: { sellerId: ctx.sellerId, userId: ctx.actorId, shopKey, stateHash: hash(state), expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS) },
  });
  return { ok: true, authorizeUrl: provider.authorizeUrl(shopKey, state) };
}

export type CompleteResult = { ok: true; connectionId: string } | { ok: false; reason: "invalid_state" | "integration_disabled" | "exchange_failed" | "already_connected" };

// 콜백: 연결을 시작한 같은 파트너스·같은 직원 세션이고, 아직 안 쓴 만료 전 state일 때만 토큰을 받아 저장한다.
// 다른 파트너스·다른 직원의 state는 쓰지도 태우지도 않는다(거절만). 맞는 state는 토큰 교환 전에 먼저 태운다(재사용 불가).
export async function completeConnect(db: PrismaClient, provider: ExternalShopProvider | null, ctx: TenantContext, input: { state: unknown; code: unknown }): Promise<CompleteResult> {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  if (!provider) return { ok: false, reason: "integration_disabled" };
  if (typeof input.state !== "string" || typeof input.code !== "string" || !input.state || !input.code || input.code.length > 2000) return { ok: false, reason: "invalid_state" };
  const row = await db.externalOAuthState.findUnique({ where: { stateHash: hash(input.state) } });
  const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  if (!row || row.usedAt || row.expiresAt <= now || row.sellerId !== ctx.sellerId || row.userId !== ctx.actorId) return { ok: false, reason: "invalid_state" };
  const burned = await db.externalOAuthState.updateMany({ where: { id: row.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
  if (burned.count !== 1) return { ok: false, reason: "invalid_state" };
  let tokens;
  try {
    tokens = await provider.exchangeCode(row.shopKey, input.code);
  } catch {
    return { ok: false, reason: "exchange_failed" };
  }
  await recordExternalCost(db, { provider: EXTERNAL_PROVIDER, purpose: "oauth_exchange", costWon: 0 });
  const data = {
    status: "CONNECTED" as const,
    accessTokenCipher: sealBillingKey(tokens.accessToken, ctx.sellerId),
    refreshTokenCipher: sealBillingKey(tokens.refreshToken, ctx.sellerId),
    accessExpiresAt: tokens.accessExpiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    scopes: tokens.scopes,
    disconnectedAt: null,
  };
  try {
    const conn = await db.$transaction(async (tx) => {
      const c = await tx.externalShopConnection.upsert({
        where: { sellerId_shopKey: { sellerId: ctx.sellerId, shopKey: row.shopKey } },
        create: { sellerId: ctx.sellerId, shopKey: row.shopKey, ...data },
        update: data,
      });
      await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "external_shop.connect", targetType: "ExternalShopConnection", targetId: c.id, after: { shopKey: c.shopKey, status: c.status } });
      return c;
    });
    return { ok: true, connectionId: conn.id };
  } catch (e) {
    if (isUnique(e)) return { ok: false, reason: "already_connected" };
    throw e;
  }
}

export type ConnectionView = { id: string; shopKey: string; status: ExternalShopConnection["status"]; connectedAt: Date; lastEventAt: Date | null };

// 목록은 같은 파트너스 계정이면 누구나 본다(보기만, 토큰·웹훅 값은 없다). 바꾸기는 대표자·쇼핑몰 설정 직원만.
export async function listConnections(db: PrismaClient, ctx: TenantContext): Promise<ConnectionView[]> {
  const rows = await db.externalShopConnection.findMany({ where: { sellerId: ctx.sellerId, status: { not: "DISCONNECTED" } }, orderBy: { createdAt: "asc" } });
  return rows.map((c) => ({ id: c.id, shopKey: c.shopKey, status: c.status, connectedAt: c.connectedAt, lastEventAt: c.lastEventAt }));
}

export type DisconnectResult = { ok: true; status: "DISCONNECTED" | "DISCONNECT_PENDING" };

// 해제: 쇼핑몰 쪽 토큰 철회를 요청한다. 성공하면 토큰을 지우고 해제됨, 시간 초과·5xx면 「해제 대기」로 두고 철회 재시도용 사본만 남긴다.
// 해제 대기·해제됨은 주문 수신을 받지 않는다(웹훅은 연결됨 상태만 받는다).
export async function disconnect(db: PrismaClient, provider: ExternalShopProvider | null, ctx: TenantContext, connectionId: string): Promise<DisconnectResult> {
  requireSellerPermission(ctx, "SHOP_SETTINGS");
  const c = await db.externalShopConnection.findFirst({ where: { id: connectionId, sellerId: ctx.sellerId } });
  if (!c) throw notFound();
  if (c.status === "DISCONNECTED") return { ok: true, status: "DISCONNECTED" };
  let revoked: "ok" | "retry" = "retry";
  if (provider && c.refreshTokenCipher) {
    try {
      revoked = await provider.revoke(c.shopKey, openBillingKey(c.refreshTokenCipher, ctx.sellerId));
    } catch {
      revoked = "retry";
    }
  } else if (!c.refreshTokenCipher) revoked = "ok";
  const now = new Date();
  const status = revoked === "ok" ? ("DISCONNECTED" as const) : ("DISCONNECT_PENDING" as const);
  await db.$transaction(async (tx) => {
    await tx.externalShopConnection.update({
      where: { id: c.id },
      data: revoked === "ok" ? { status, accessTokenCipher: null, refreshTokenCipher: null, accessExpiresAt: null, refreshExpiresAt: null, disconnectedAt: now } : { status, accessTokenCipher: null, accessExpiresAt: null },
    });
    await writeAudit(tx, { actorType: ctx.actorType, actorId: ctx.actorId, sellerId: ctx.sellerId, action: "external_shop.disconnect", targetType: "ExternalShopConnection", targetId: c.id, before: { status: c.status }, after: { status } });
  });
  return { ok: true, status };
}
