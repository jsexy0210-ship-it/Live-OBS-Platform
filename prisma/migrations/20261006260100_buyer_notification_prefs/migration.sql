-- 구매자 알림 설정(SH-025): 끌 수 있는 칸(배송 · 방송 시작 · 할인 · 재입고)만 저장, 줄이 없으면 켬
CREATE TABLE "BuyerNotificationPref" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerNotificationPref_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "BuyerNotificationPref_kind_check" CHECK ("kind" IN ('SHIPPING', 'BROADCAST_START', 'DISCOUNT_RESTOCK')),
    CONSTRAINT "BuyerNotificationPref_channel_check" CHECK ("channel" IN ('MESSAGE', 'EMAIL')),
    -- 광고성 줄(방송 시작 · 할인 · 재입고)은 메일만(PRODUCT_SCOPE: 광고성 알림톡 금지)
    CONSTRAINT "BuyerNotificationPref_ad_email_only_check" CHECK ("kind" = 'SHIPPING' OR "channel" = 'EMAIL')
);

CREATE UNIQUE INDEX "BuyerNotificationPref_buyerMemberId_kind_channel_key" ON "BuyerNotificationPref"("buyerMemberId", "kind", "channel");
CREATE INDEX "BuyerNotificationPref_sellerId_buyerMemberId_idx" ON "BuyerNotificationPref"("sellerId", "buyerMemberId");

ALTER TABLE "BuyerNotificationPref" ADD CONSTRAINT "BuyerNotificationPref_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
