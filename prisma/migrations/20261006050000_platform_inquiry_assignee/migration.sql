-- AlterTable
ALTER TABLE "PlatformInquiry" ADD COLUMN "assignedAdminId" UUID,
ADD COLUMN "assignedAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "PlatformInquiry_assignedAdminId_lastMessageAt_id_idx" ON "PlatformInquiry"("assignedAdminId", "lastMessageAt" DESC, "id" DESC);
