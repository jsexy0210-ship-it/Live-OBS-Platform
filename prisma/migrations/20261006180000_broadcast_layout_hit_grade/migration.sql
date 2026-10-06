-- SA-054 방송 이력 「레이아웃」 열(방송 중 오버레이가 처음 요청한 레이아웃)·SA-053 HIT 카드 「등급」 열. 모두 추가형(null 허용).
ALTER TABLE "BroadcastSession" ADD COLUMN "layoutAspect" TEXT;
ALTER TABLE "HitCard" ADD COLUMN "grade" TEXT;
