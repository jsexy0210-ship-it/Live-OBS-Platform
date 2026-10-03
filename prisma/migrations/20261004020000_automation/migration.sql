-- CreateEnum
CREATE TYPE "AutomationPaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'REFUND_PENDING', 'REFUNDED');

-- CreateEnum
CREATE TYPE "AutomationJobKind" AS ENUM ('INITIAL', 'REINSTALL', 'RECONNECT_FREE');

-- CreateEnum
CREATE TYPE "AutomationJobStatus" AS ENUM ('AWAITING_PAYMENT', 'QUEUED', 'RUNNING', 'NEEDS_CUSTOMER', 'VERIFYING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "AutomationCustomerAction" AS ENUM ('LOGIN', 'TWO_FACTOR', 'CAPTCHA', 'PERMISSION_GRANT', 'LOCAL_TOOL');

-- CreateEnum
CREATE TYPE "AutomationPracticeOutcome" AS ENUM ('SUCCEEDED', 'FAILED', 'NEEDS_CUSTOMER');

-- CreateTable
CREATE TABLE "AutomationPayment" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "AutomationPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT NOT NULL,
    "requestFingerprint" TEXT NOT NULL,
    "consentNoticeVersion" TEXT NOT NULL,
    "consentAgreedAt" TIMESTAMPTZ(3) NOT NULL,
    "providerPaymentId" TEXT,
    "failureReason" TEXT,
    "paidAt" TIMESTAMPTZ(3),
    "refundReason" TEXT,
    "refundRequestedAt" TIMESTAMPTZ(3),
    "refundedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AutomationPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationJob" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "kind" "AutomationJobKind" NOT NULL DEFAULT 'INITIAL',
    "paymentId" UUID,
    "baseJobId" UUID,
    "status" "AutomationJobStatus" NOT NULL DEFAULT 'AWAITING_PAYMENT',
    "obsTargetKey" TEXT NOT NULL,
    "stepIndex" INTEGER NOT NULL DEFAULT 0,
    "customerAction" "AutomationCustomerAction",
    "actionDeadlineAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "costUsed" INTEGER NOT NULL DEFAULT 0,
    "costLimit" INTEGER NOT NULL DEFAULT 3000,
    "runAfter" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "fencingToken" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "shopKey" TEXT,
    "obsPairingId" TEXT,
    "connectionRevokedAt" TIMESTAMPTZ(3),
    "verifiedAt" TIMESTAMPTZ(3),
    "verificationEvidence" JSONB,
    "playbookId" TEXT,
    "playbookVersion" INTEGER,
    "browserStateHeld" BOOLEAN NOT NULL DEFAULT false,
    "artifactsPurgedAt" TIMESTAMPTZ(3),
    "idempotencyKey" TEXT,
    "requestFingerprint" TEXT,
    "plannerCalls" INTEGER NOT NULL DEFAULT 0,
    "playbookActions" INTEGER NOT NULL DEFAULT 0,
    "deviatedSteps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "activeMsUsed" INTEGER NOT NULL DEFAULT 0,
    "runStartedAt" TIMESTAMPTZ(3),
    "lastDeviationAt" TIMESTAMPTZ(3),
    "targetVerifiedAt" TIMESTAMPTZ(3),
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "AutomationJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationJobEvent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "sellerId" UUID NOT NULL,
    "jobId" UUID NOT NULL,
    "fromStatus" "AutomationJobStatus",
    "toStatus" "AutomationJobStatus" NOT NULL,
    "fencingToken" INTEGER NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationJobEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AutomationPracticeRun" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "playbookId" TEXT NOT NULL,
    "playbookVersion" INTEGER NOT NULL,
    "outcome" "AutomationPracticeOutcome" NOT NULL,
    "failedStep" TEXT,
    "reason" TEXT,
    "durationMs" INTEGER NOT NULL,
    "plannerCalls" INTEGER NOT NULL,
    "playbookActions" INTEGER NOT NULL,
    "costWon" INTEGER NOT NULL,
    "deviatedSteps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "finishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AutomationPracticeRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AutomationPayment_status_createdAt_idx" ON "AutomationPayment"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationPayment_sellerId_idempotencyKey_key" ON "AutomationPayment"("sellerId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationPayment_sellerId_id_key" ON "AutomationPayment"("sellerId", "id");

-- CreateIndex
CREATE INDEX "AutomationJob_status_runAfter_idx" ON "AutomationJob"("status", "runAfter");

-- CreateIndex
CREATE INDEX "AutomationJob_sellerId_createdAt_idx" ON "AutomationJob"("sellerId", "createdAt");

-- CreateIndex
CREATE INDEX "AutomationJob_sellerId_status_finishedAt_idx" ON "AutomationJob"("sellerId", "status", "finishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationJob_sellerId_id_key" ON "AutomationJob"("sellerId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationJob_sellerId_paymentId_key" ON "AutomationJob"("sellerId", "paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "AutomationJob_sellerId_idempotencyKey_key" ON "AutomationJob"("sellerId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "AutomationJobEvent_jobId_createdAt_idx" ON "AutomationJobEvent"("jobId", "createdAt");

-- CreateIndex
CREATE INDEX "AutomationPracticeRun_playbookId_playbookVersion_finishedAt_idx" ON "AutomationPracticeRun"("playbookId", "playbookVersion", "finishedAt");

-- AddForeignKey
ALTER TABLE "AutomationJob" ADD CONSTRAINT "AutomationJob_sellerId_paymentId_fkey" FOREIGN KEY ("sellerId", "paymentId") REFERENCES "AutomationPayment"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AutomationJobEvent" ADD CONSTRAINT "AutomationJobEvent_sellerId_jobId_fkey" FOREIGN KEY ("sellerId", "jobId") REFERENCES "AutomationJob"("sellerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- 판매자당 열린(끝나지 않은) 자동 연결 작업은 1개. 버튼 연타·다른 키로 다시 눌러도 두 번째 결제·작업이 생기지 않는다.
CREATE UNIQUE INDEX "AutomationJob_one_open_per_seller" ON "AutomationJob"("sellerId") WHERE "status" NOT IN ('SUCCEEDED', 'FAILED', 'CANCELED');

-- 같은 OBS 대상에는 실행 중(RUNNING·VERIFYING) 작업이 1개만 있다.
CREATE UNIQUE INDEX "AutomationJob_one_running_per_obs_target" ON "AutomationJob"("obsTargetKey") WHERE "status" IN ('RUNNING', 'VERIFYING');

ALTER TABLE "AutomationPayment" ADD CONSTRAINT "AutomationPayment_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "AutomationJob" ADD CONSTRAINT "AutomationJob_counters_valid" CHECK ("activeMsUsed" >= 0 AND "attempts" >= 0 AND "maxAttempts" > 0 AND "costUsed" >= 0 AND "costLimit" > 0 AND "stepIndex" >= 0 AND "fencingToken" >= 0);
-- 실행 중이면 실행 자리(lease)가 있고, 실행 중이 아니면 없다.
ALTER TABLE "AutomationJob" ADD CONSTRAINT "AutomationJob_lease_matches_status" CHECK (("status" IN ('RUNNING', 'VERIFYING')) = ("leaseOwner" IS NOT NULL AND "leaseExpiresAt" IS NOT NULL));
-- 무료 재연결만 결제가 없고, 나머지는 결제가 있어야 한다.
ALTER TABLE "AutomationJob" ADD CONSTRAINT "AutomationJob_payment_matches_kind" CHECK (("kind" = 'RECONNECT_FREE') = ("paymentId" IS NULL));
ALTER TABLE "AutomationJob" ADD CONSTRAINT "AutomationJob_stats_valid" CHECK ("plannerCalls" >= 0 AND "playbookActions" >= 0 AND ("playbookId" IS NULL) = ("playbookVersion" IS NULL));
ALTER TABLE "AutomationPracticeRun" ADD CONSTRAINT "AutomationPracticeRun_counters_valid" CHECK ("playbookVersion" > 0 AND "durationMs" >= 0 AND "plannerCalls" >= 0 AND "playbookActions" >= 0 AND "costWon" >= 0);
-- 끝난 작업 중 보관 자료 삭제를 아직 요청하지 않은 것만 빠르게 찾는다
CREATE INDEX "AutomationJob_artifacts_purge" ON "AutomationJob"("updatedAt") WHERE "artifactsPurgedAt" IS NULL AND "status" IN ('SUCCEEDED', 'FAILED', 'CANCELED');
