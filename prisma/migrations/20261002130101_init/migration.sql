-- CreateEnum
CREATE TYPE "PlatformAdminRole" AS ENUM ('SUPER_ADMIN', 'OPERATIONS', 'CS', 'READ_ONLY');

-- CreateEnum
CREATE TYPE "PlatformAdminStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "SellerStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "SellerUserRole" AS ENUM ('OWNER', 'MANAGER', 'BROADCASTER');

-- CreateEnum
CREATE TYPE "SellerUserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "GradeSystemKey" AS ENUM ('BASIC', 'SPROUT', 'SILVER', 'GOLD', 'VIP');

-- CreateEnum
CREATE TYPE "BuyerMemberStatus" AS ENUM ('ACTIVE', 'DORMANT', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "PhoneVerificationPurpose" AS ENUM ('SIGNUP', 'RESET');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'ON_SALE', 'SOLD_OUT', 'HIDDEN');

-- CreateEnum
CREATE TYPE "StockMovementReason" AS ENUM ('ORDER', 'CANCEL', 'REFUND', 'MANUAL');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('PLATFORM_ADMIN', 'SELLER_USER', 'BUYER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('PENDING_PAYMENT', 'PAID', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('LIVE', 'ENDED');

-- CreateEnum
CREATE TYPE "QueueItemStatus" AS ENUM ('WAITING', 'OPENING', 'DONE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RevokeMode" AS ENUM ('AUTO', 'MANUAL');

-- CreateEnum
CREATE TYPE "RewardLedgerType" AS ENUM ('EARN', 'REVOKE', 'USE', 'RANKING_BONUS', 'ADJUST');

-- CreateEnum
CREATE TYPE "RewardLedgerStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "PlatformAdmin" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "PlatformAdminRole" NOT NULL,
    "status" "PlatformAdminStatus" NOT NULL DEFAULT 'ACTIVE',
    "totpSecretEnc" TEXT,
    "totpEnabledAt" TIMESTAMPTZ(3),
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAdmin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "adminId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "mfaVerifiedAt" TIMESTAMPTZ(3),
    "ip" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Seller" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slug" TEXT NOT NULL,
    "shopName" TEXT NOT NULL,
    "status" "SellerStatus" NOT NULL DEFAULT 'PENDING',
    "businessInfo" JSONB,
    "approvedAt" TIMESTAMPTZ(3),
    "approvedByAdminId" UUID,
    "suspendedReason" TEXT,
    "representativeCiHash" TEXT,
    "liveVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Seller_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerDomain" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "hostname" TEXT NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3),
    "certStatus" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerUser" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "SellerUserRole" NOT NULL,
    "status" "SellerUserStatus" NOT NULL DEFAULT 'ACTIVE',
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "lastLoginAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SellerSession" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerUserId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SellerSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemberGrade" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "displayName" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "systemKey" "GradeSystemKey",
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MemberGrade_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerMember" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "loginId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "phoneVerifiedAt" TIMESTAMPTZ(3),
    "ciHash" TEXT NOT NULL,
    "identityVerifiedAt" TIMESTAMPTZ(3) NOT NULL,
    "broadcastNickname" TEXT NOT NULL,
    "gradeId" UUID NOT NULL,
    "status" "BuyerMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "marketingConsentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "BuyerMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneVerification" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "purpose" "PhoneVerificationPurpose" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PhoneVerification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuyerSession" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "buyerMemberId" UUID NOT NULL,
    "sellerId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BuyerSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" INTEGER NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductOption" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "priceDelta" INTEGER NOT NULL DEFAULT 0,
    "stock" INTEGER NOT NULL DEFAULT 0,
    "sku" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductOption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "optionId" UUID NOT NULL,
    "delta" INTEGER NOT NULL,
    "reason" "StockMovementReason" NOT NULL,
    "orderId" UUID,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "orderNo" INTEGER NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "status" "OrderStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "broadcastNicknameSnapshot" TEXT NOT NULL,
    "totalAmount" INTEGER NOT NULL,
    "rewardUsedAmount" INTEGER NOT NULL DEFAULT 0,
    "paymentMethod" "PaymentMethod",
    "pgProvider" TEXT,
    "pgTxId" TEXT,
    "paidAt" TIMESTAMPTZ(3),
    "stockShortageAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "refundedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "optionId" UUID NOT NULL,
    "productNameSnapshot" TEXT NOT NULL,
    "optionNameSnapshot" TEXT NOT NULL,
    "unitPrice" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderStatusHistory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "fromStatus" "OrderStatus",
    "toStatus" "OrderStatus" NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BroadcastSession" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'LIVE',
    "title" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMPTZ(3),

    CONSTRAINT "BroadcastSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueItem" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "orderItemId" UUID NOT NULL,
    "broadcastSessionId" UUID,
    "status" "QueueItemStatus" NOT NULL DEFAULT 'WAITING',
    "position" INTEGER NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "nicknameSnapshot" TEXT NOT NULL,
    "gradeSnapshot" TEXT,
    "productLabel" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "timerSeconds" INTEGER NOT NULL DEFAULT 0,
    "openingStartedAt" TIMESTAMPTZ(3),
    "doneAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "cancelReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueueItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QueueItemStatusHistory" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "queueItemId" UUID NOT NULL,
    "fromStatus" "QueueItemStatus",
    "toStatus" "QueueItemStatus" NOT NULL,
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "reason" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QueueItemStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HitCard" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "broadcastSessionId" UUID,
    "queueItemId" UUID,
    "buyerMemberId" UUID,
    "nicknameSnapshot" TEXT NOT NULL,
    "cardName" TEXT NOT NULL,
    "note" TEXT,
    "createdByUserId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HitCard_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardPolicy" (
    "sellerId" UUID NOT NULL,
    "rates" JSONB NOT NULL DEFAULT '{}',
    "earnStartsAt" TIMESTAMPTZ(3),
    "revokeMode" "RevokeMode" NOT NULL DEFAULT 'AUTO',
    "livePayoutEnabled" BOOLEAN NOT NULL DEFAULT false,
    "livePayoutChangedAt" TIMESTAMPTZ(3),
    "livePayoutChangedBy" UUID,
    "rankingBonusEnabled" BOOLEAN NOT NULL DEFAULT false,
    "rankingBonusAmount" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardPolicy_pkey" PRIMARY KEY ("sellerId")
);

-- CreateTable
CREATE TABLE "RewardLedger" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "orderId" UUID,
    "type" "RewardLedgerType" NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "RewardLedgerStatus" NOT NULL DEFAULT 'PENDING',
    "testMode" BOOLEAN NOT NULL,
    "failureReason" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),

    CONSTRAINT "RewardLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RewardBalance" (
    "sellerId" UUID NOT NULL,
    "buyerMemberId" UUID NOT NULL,
    "balance" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RewardBalance_pkey" PRIMARY KEY ("sellerId","buyerMemberId")
);

-- CreateTable
CREATE TABLE "OverlayToken" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMPTZ(3),

    CONSTRAINT "OverlayToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "actorType" "ActorType" NOT NULL,
    "actorId" UUID,
    "sellerId" UUID,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PlatformAdmin_email_key" ON "PlatformAdmin"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminSession_adminId_idx" ON "AdminSession"("adminId");

-- CreateIndex
CREATE UNIQUE INDEX "Seller_slug_key" ON "Seller"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "SellerDomain_hostname_key" ON "SellerDomain"("hostname");

-- CreateIndex
CREATE INDEX "SellerDomain_sellerId_idx" ON "SellerDomain"("sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "SellerUser_sellerId_id_key" ON "SellerUser"("sellerId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "SellerUser_sellerId_email_key" ON "SellerUser"("sellerId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "SellerSession_tokenHash_key" ON "SellerSession"("tokenHash");

-- CreateIndex
CREATE INDEX "SellerSession_sellerId_sellerUserId_idx" ON "SellerSession"("sellerId", "sellerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MemberGrade_sellerId_id_key" ON "MemberGrade"("sellerId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "MemberGrade_sellerId_displayName_key" ON "MemberGrade"("sellerId", "displayName");

-- CreateIndex
CREATE UNIQUE INDEX "MemberGrade_sellerId_systemKey_key" ON "MemberGrade"("sellerId", "systemKey");

-- CreateIndex
CREATE INDEX "BuyerMember_sellerId_gradeId_idx" ON "BuyerMember"("sellerId", "gradeId");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerMember_sellerId_id_key" ON "BuyerMember"("sellerId", "id");

-- CreateIndex
CREATE INDEX "PhoneVerification_sellerId_phone_idx" ON "PhoneVerification"("sellerId", "phone");

-- CreateIndex
CREATE UNIQUE INDEX "BuyerSession_tokenHash_key" ON "BuyerSession"("tokenHash");

-- CreateIndex
CREATE INDEX "BuyerSession_sellerId_buyerMemberId_idx" ON "BuyerSession"("sellerId", "buyerMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "Product_sellerId_id_key" ON "Product"("sellerId", "id");

-- CreateIndex
CREATE INDEX "ProductImage_sellerId_productId_idx" ON "ProductImage"("sellerId", "productId");

-- CreateIndex
CREATE INDEX "ProductOption_sellerId_productId_idx" ON "ProductOption"("sellerId", "productId");

-- CreateIndex
CREATE UNIQUE INDEX "ProductOption_sellerId_id_key" ON "ProductOption"("sellerId", "id");

-- CreateIndex
CREATE INDEX "StockMovement_sellerId_optionId_idx" ON "StockMovement"("sellerId", "optionId");

-- CreateIndex
CREATE INDEX "Order_sellerId_buyerMemberId_idx" ON "Order"("sellerId", "buyerMemberId");

-- CreateIndex
CREATE INDEX "Order_sellerId_status_idx" ON "Order"("sellerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Order_sellerId_id_key" ON "Order"("sellerId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Order_sellerId_orderNo_key" ON "Order"("sellerId", "orderNo");

-- CreateIndex
CREATE INDEX "OrderItem_sellerId_orderId_idx" ON "OrderItem"("sellerId", "orderId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItem_sellerId_id_key" ON "OrderItem"("sellerId", "id");

-- CreateIndex
CREATE INDEX "OrderStatusHistory_sellerId_orderId_idx" ON "OrderStatusHistory"("sellerId", "orderId");

-- CreateIndex
CREATE INDEX "BroadcastSession_sellerId_status_idx" ON "BroadcastSession"("sellerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "BroadcastSession_sellerId_id_key" ON "BroadcastSession"("sellerId", "id");

-- CreateIndex
CREATE INDEX "QueueItem_sellerId_status_position_idx" ON "QueueItem"("sellerId", "status", "position");

-- CreateIndex
CREATE INDEX "QueueItem_sellerId_broadcastSessionId_idx" ON "QueueItem"("sellerId", "broadcastSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "QueueItem_sellerId_id_key" ON "QueueItem"("sellerId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "QueueItem_sellerId_orderItemId_key" ON "QueueItem"("sellerId", "orderItemId");

-- CreateIndex
CREATE INDEX "QueueItemStatusHistory_sellerId_queueItemId_idx" ON "QueueItemStatusHistory"("sellerId", "queueItemId");

-- CreateIndex
CREATE INDEX "HitCard_sellerId_broadcastSessionId_idx" ON "HitCard"("sellerId", "broadcastSessionId");

-- CreateIndex
CREATE INDEX "RewardLedger_sellerId_buyerMemberId_idx" ON "RewardLedger"("sellerId", "buyerMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "RewardLedger_sellerId_idempotencyKey_key" ON "RewardLedger"("sellerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "OverlayToken_tokenHash_key" ON "OverlayToken"("tokenHash");

-- CreateIndex
CREATE INDEX "OverlayToken_sellerId_idx" ON "OverlayToken"("sellerId");

-- CreateIndex
CREATE INDEX "AuditLog_sellerId_createdAt_idx" ON "AuditLog"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_action_createdAt_idx" ON "AuditLog"("action", "createdAt");

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "PlatformAdmin"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Seller" ADD CONSTRAINT "Seller_approvedByAdminId_fkey" FOREIGN KEY ("approvedByAdminId") REFERENCES "PlatformAdmin"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerDomain" ADD CONSTRAINT "SellerDomain_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerUser" ADD CONSTRAINT "SellerUser_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerSession" ADD CONSTRAINT "SellerSession_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SellerSession" ADD CONSTRAINT "SellerSession_sellerId_sellerUserId_fkey" FOREIGN KEY ("sellerId", "sellerUserId") REFERENCES "SellerUser"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemberGrade" ADD CONSTRAINT "MemberGrade_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerMember" ADD CONSTRAINT "BuyerMember_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerMember" ADD CONSTRAINT "BuyerMember_sellerId_gradeId_fkey" FOREIGN KEY ("sellerId", "gradeId") REFERENCES "MemberGrade"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneVerification" ADD CONSTRAINT "PhoneVerification_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerSession" ADD CONSTRAINT "BuyerSession_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuyerSession" ADD CONSTRAINT "BuyerSession_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_sellerId_productId_fkey" FOREIGN KEY ("sellerId", "productId") REFERENCES "Product"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductOption" ADD CONSTRAINT "ProductOption_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductOption" ADD CONSTRAINT "ProductOption_sellerId_productId_fkey" FOREIGN KEY ("sellerId", "productId") REFERENCES "Product"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_sellerId_optionId_fkey" FOREIGN KEY ("sellerId", "optionId") REFERENCES "ProductOption"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_sellerId_productId_fkey" FOREIGN KEY ("sellerId", "productId") REFERENCES "Product"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_sellerId_optionId_fkey" FOREIGN KEY ("sellerId", "optionId") REFERENCES "ProductOption"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BroadcastSession" ADD CONSTRAINT "BroadcastSession_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_sellerId_orderItemId_fkey" FOREIGN KEY ("sellerId", "orderItemId") REFERENCES "OrderItem"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_sellerId_broadcastSessionId_fkey" FOREIGN KEY ("sellerId", "broadcastSessionId") REFERENCES "BroadcastSession"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueItemStatusHistory" ADD CONSTRAINT "QueueItemStatusHistory_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QueueItemStatusHistory" ADD CONSTRAINT "QueueItemStatusHistory_sellerId_queueItemId_fkey" FOREIGN KEY ("sellerId", "queueItemId") REFERENCES "QueueItem"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HitCard" ADD CONSTRAINT "HitCard_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HitCard" ADD CONSTRAINT "HitCard_sellerId_broadcastSessionId_fkey" FOREIGN KEY ("sellerId", "broadcastSessionId") REFERENCES "BroadcastSession"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HitCard" ADD CONSTRAINT "HitCard_sellerId_queueItemId_fkey" FOREIGN KEY ("sellerId", "queueItemId") REFERENCES "QueueItem"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HitCard" ADD CONSTRAINT "HitCard_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardPolicy" ADD CONSTRAINT "RewardPolicy_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardLedger" ADD CONSTRAINT "RewardLedger_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardLedger" ADD CONSTRAINT "RewardLedger_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardLedger" ADD CONSTRAINT "RewardLedger_sellerId_orderId_fkey" FOREIGN KEY ("sellerId", "orderId") REFERENCES "Order"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardBalance" ADD CONSTRAINT "RewardBalance_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RewardBalance" ADD CONSTRAINT "RewardBalance_sellerId_buyerMemberId_fkey" FOREIGN KEY ("sellerId", "buyerMemberId") REFERENCES "BuyerMember"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OverlayToken" ADD CONSTRAINT "OverlayToken_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ───────────── Prisma 스키마로 표현할 수 없는 제약 (docs/ARCHITECTURE.md 4절) ─────────────

-- 판매자당 「개봉 중」 1건
CREATE UNIQUE INDEX "QueueItem_one_opening_per_seller" ON "QueueItem"("sellerId") WHERE "status" = 'OPENING';

-- 판매자당 LIVE 방송 1개
CREATE UNIQUE INDEX "BroadcastSession_one_live_per_seller" ON "BroadcastSession"("sellerId") WHERE "status" = 'LIVE';

-- 구매자 회원 유니크는 탈퇴하지 않은 회원(deletedAt IS NULL)에만 적용
CREATE UNIQUE INDEX "BuyerMember_sellerId_ciHash_active_key" ON "BuyerMember"("sellerId", "ciHash") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "BuyerMember_sellerId_phone_active_key" ON "BuyerMember"("sellerId", "phone") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "BuyerMember_sellerId_loginId_active_key" ON "BuyerMember"("sellerId", "loginId") WHERE "deletedAt" IS NULL;
CREATE UNIQUE INDEX "BuyerMember_sellerId_broadcastNickname_active_key" ON "BuyerMember"("sellerId", "broadcastNickname") WHERE "deletedAt" IS NULL;

-- 탈퇴 상태와 deletedAt은 함께 기록
ALTER TABLE "BuyerMember" ADD CONSTRAINT "BuyerMember_withdrawn_deleted_check"
  CHECK (("status" = 'WITHDRAWN') = ("deletedAt" IS NOT NULL));

-- 재고·잔액·수량·금액 범위
ALTER TABLE "ProductOption" ADD CONSTRAINT "ProductOption_stock_check" CHECK ("stock" >= 0);
ALTER TABLE "RewardBalance" ADD CONSTRAINT "RewardBalance_balance_check" CHECK ("balance" >= 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_unitPrice_check" CHECK ("unitPrice" >= 0);
ALTER TABLE "Order" ADD CONSTRAINT "Order_amount_check" CHECK ("totalAmount" >= 0 AND "rewardUsedAmount" >= 0);
ALTER TABLE "Product" ADD CONSTRAINT "Product_price_check" CHECK ("price" >= 0);
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_quantity_check" CHECK ("quantity" > 0);
ALTER TABLE "QueueItem" ADD CONSTRAINT "QueueItem_timerSeconds_check" CHECK ("timerSeconds" BETWEEN 0 AND 3600);
ALTER TABLE "RewardPolicy" ADD CONSTRAINT "RewardPolicy_rankingBonusAmount_check" CHECK ("rankingBonusAmount" >= 0);

-- 대표자 1명당 쇼핑몰 1개 (대표자 CI 기준, 해지·반려된 쇼핑몰은 제외)
CREATE UNIQUE INDEX "Seller_representativeCiHash_open_key" ON "Seller"("representativeCiHash")
  WHERE "representativeCiHash" IS NOT NULL AND "status" NOT IN ('CLOSED', 'REJECTED');
