-- 플랫폼 사업자 정보에 통신판매업 신고번호·이메일 칸 추가(MA-088, 추가형)
ALTER TABLE "PlatformBusinessInfo" ADD COLUMN "mailOrderNumber" TEXT NOT NULL DEFAULT '', ADD COLUMN "email" TEXT NOT NULL DEFAULT '';
