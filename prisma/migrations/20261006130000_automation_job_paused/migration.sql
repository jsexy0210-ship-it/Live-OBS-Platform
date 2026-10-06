-- SA-152 「잠시 멈추기」: 멈춘 시각. 있으면 작업자가 실행 자리를 주지 않는다(상태는 QUEUED, 단계는 그대로).
ALTER TABLE "AutomationJob" ADD COLUMN "pausedAt" TIMESTAMPTZ(3);
