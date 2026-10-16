-- 점검 창 도입 마이그레이션(20261013100000)이 사유가 있던 켜진 점검도 자리표시 사유로 옮겼던 것을 바로잡는다.
-- 아직 열려 있는 창만, 지금 상태 사본에 사유가 있을 때만 사본의 사유를 되돌린다(이미 닫힌 창·직접 만든 창은 건드리지 않는다).
UPDATE "PlatformMaintenanceWindow" w
SET "reason" = m."reason"
FROM "PlatformMaintenance" m
WHERE m."id" = 1 AND m."enabled" = true AND m."reason" <> ''
  AND w."status" = 'SCHEDULED' AND w."reason" = '이전 설정에서 가져옴' AND w."message" = m."message";
