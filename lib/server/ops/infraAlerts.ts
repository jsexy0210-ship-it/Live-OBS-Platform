import type { AdminAlertSeverity, Prisma, PrismaClient } from "@prisma/client";
import { createAdminAlert } from "../admin-alerts/service";
import { readConnections } from "./connections";
import { computeInfraCost } from "./infraCost";
import { INFRA_THRESHOLDS, infraSignals, measureInfra, type InfraSignal } from "./infra";

// 인프라 알림(MA-002 알림 센터, 최고관리자만 보임). 정기 실행 infra_alerts.evaluate가 시간마다 판단해
// createAdminAlert 한 곳으로만 만든다. 같은 상황은 dedupeKey로 한 번만 만들고(하루·한 달·만료일·오류 시각 단위), 화면 안 알림만이다.
type Db = PrismaClient | Prisma.TransactionClient;

const KST_MS = 9 * 3_600_000;
const kstDate = (d: Date) => new Date(d.getTime() + KST_MS).toISOString().slice(0, 10);
const TARGET = ["SUPER_ADMIN"] as const;
const LINK = "/admin/ops/infra";

const SIGNAL_KIND: Record<InfraSignal["key"], { kind: string; label: string; unit: string }> = {
  disk: { kind: "INFRA_DISK", label: "디스크 사용률", unit: "%" },
  memory: { kind: "INFRA_MEMORY", label: "메모리 사용률", unit: "%" },
  cpu: { kind: "INFRA_CPU", label: "CPU 사용률", unit: "%" },
  dbConnections: { kind: "INFRA_DB_CONNECTIONS", label: "DB 연결 사용률", unit: "%" },
  backupStale: { kind: "INFRA_BACKUP_STALE", label: "마지막 백업 경과", unit: "시간" },
};

const LIMIT_LABEL = (key: string) => (key === "assistant" ? "도우미" : key.startsWith("externalApi:") ? `자동 연결(${key.slice("externalApi:".length)})` : key);

// 알림을 새로 만든 수를 돌려준다(이미 있던 알림은 세지 않음)
export async function evaluateInfraAlerts(db: Db, now: Date): Promise<number> {
  const today = kstDate(now);
  const month = today.slice(0, 7);
  let created = 0;
  const make = async (a: { kind: string; severity: AdminAlertSeverity; title: string; body?: string; dedupeKey: string }) => {
    if ((await createAdminAlert(db, { ...a, linkPath: LINK, targetRoles: TARGET, occurredAt: now })).created) created++;
  };

  // 서버 용량: 같은 항목·같은 수준은 하루 한 번(경고에서 위험으로 오르면 새로 알린다)
  const m = await measureInfra(db, now);
  for (const s of infraSignals(m)) {
    const k = SIGNAL_KIND[s.key];
    const critical = s.level === "critical";
    const base = s.key === "backupStale" ? INFRA_THRESHOLDS.backupMaxAgeHours : critical ? INFRA_THRESHOLDS.criticalPct : INFRA_THRESHOLDS.warnPct;
    await make({
      kind: k.kind,
      severity: critical ? "URGENT" : "WARNING",
      title: `${k.label} ${s.value}${k.unit}(${critical ? "위험" : "경고"} 기준 ${critical && s.key === "backupStale" ? base * 2 : base}${k.unit})`,
      body: `서버 ${m.instance}`,
      dedupeKey: `infra-${s.key}:${s.level}:${today}`,
    });
  }

  // 월 1만 원 한도 기능 정지: 기능마다 한 달에 한 번
  for (const l of (await computeInfraCost(db, now)).limited) {
    if (l.stopped) await make({ kind: "INFRA_LIMIT_STOPPED", severity: "WARNING", title: `${LIMIT_LABEL(l.key)} 월 한도 도달, 기능 정지`, body: `사용액 ${l.usedWon.toLocaleString("ko-KR")}원 / 한도 ${l.limitWon.toLocaleString("ko-KR")}원`, dedupeKey: `infra-limit:${l.key}:${month}` });
  }

  // 외부 연결: 만료 7일 이내(지난 것 포함)는 긴급, 30일 이내는 경고(만료일마다 한 번씩), 인증 오류는 오류가 난 때마다 한 번
  for (const c of (await readConnections(db, now)).connections) {
    if (c.daysLeft !== null && c.daysLeft <= 30) {
      const urgent = c.daysLeft <= 7;
      await make({
        kind: "INFRA_CONNECTION_EXPIRING",
        severity: urgent ? "URGENT" : "WARNING",
        title: c.daysLeft < 0 ? `${c.name} 만료일 경과` : `${c.name} 만료 ${c.daysLeft}일 전`,
        body: `만료일 ${c.expiresOn}`,
        dedupeKey: `infra-conn-exp${urgent ? 7 : 30}:${c.key}:${c.expiresOn}`,
      });
    }
    if (c.status === "auth_error" && c.lastAuthErrorAt) {
      await make({ kind: "INFRA_CONNECTION_AUTH_ERROR", severity: "URGENT", title: `${c.name} 인증 오류`, body: c.lastAuthErrorCode ? `오류 ${c.lastAuthErrorCode}` : undefined, dedupeKey: `infra-conn-auth:${c.key}:${c.lastAuthErrorAt}` });
    }
  }
  return created;
}
