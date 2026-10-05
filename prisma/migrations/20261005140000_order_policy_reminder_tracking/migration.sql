-- SA-063: 입금 기한 알림(기본 켜짐)·배송 자동 조회(기본 꺼짐, 켜면 건당 발송·이용 충전금 차감)
ALTER TABLE "SellerOrderPolicy" ADD COLUMN "dueReminderEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "SellerOrderPolicy" ADD COLUMN "autoTrackingEnabled" BOOLEAN NOT NULL DEFAULT false;
