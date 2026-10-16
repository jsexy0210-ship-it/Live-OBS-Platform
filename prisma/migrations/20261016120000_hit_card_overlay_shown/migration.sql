-- SA-053 「방송 화면」 열·「다시 연출」: 추가형 변경(기존 행은 그대로, 비어 있는 값으로 시작)
ALTER TABLE "HitCard" ADD COLUMN "overlayShownAt" TIMESTAMPTZ(3);
