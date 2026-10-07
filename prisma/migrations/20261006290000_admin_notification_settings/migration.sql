CREATE TYPE "AdminNotifyChannel" AS ENUM ('SLACK', 'EMAIL', 'SMS', 'EXTERNAL_MONITOR');

CREATE TABLE "AdminNotificationChannel" (
    "channel" "AdminNotifyChannel" NOT NULL,
    "target" TEXT NOT NULL DEFAULT '',
    "minSeverity" "AdminAlertSeverity" NOT NULL DEFAULT 'URGENT',
    "includeNight" BOOLEAN NOT NULL DEFAULT false,
    "lastSentAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "updatedByAdminId" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AdminNotificationChannel_pkey" PRIMARY KEY ("channel")
);

CREATE TABLE "AdminNotificationRoute" (
    "eventKey" TEXT NOT NULL,
    "slack" BOOLEAN NOT NULL,
    "email" BOOLEAN NOT NULL,
    "sms" BOOLEAN NOT NULL,
    "roles" TEXT[],
    "nightSuppress" BOOLEAN NOT NULL,
    "updatedByAdminId" UUID,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "AdminNotificationRoute_pkey" PRIMARY KEY ("eventKey")
);
