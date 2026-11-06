-- SA-044: 승급·강등 알림 원함 / 마이페이지 「다음 등급까지 남은 금액」 표시
ALTER TABLE "MemberGradePolicy"
  ADD COLUMN "notifyPromotion" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "notifyDemotion" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "showNextGrade" BOOLEAN NOT NULL DEFAULT true;
