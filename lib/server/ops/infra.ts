import { readFileSync } from "node:fs";
import { readdir, stat, statfs } from "node:fs/promises";
import { availableParallelism, freemem, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { opsInstanceName } from "./metrics";

// 인프라 용량 실시간 확인(대표님 지시 2026-10-06). 앱이 자기 서버(디스크·메모리·CPU 부하)와 DB(크기·연결 수),
// 백업 폴더(읽을 수 있을 때만)를 직접 잰다. 외부 감시 서비스·비밀값을 쓰지 않는다. 잴 수 없는 값은 null(= 못 잼)이다.

type Db = PrismaClient | Prisma.TransactionClient;

export const INFRA_SNAPSHOT_RETENTION_DAYS = 35;
// 신호 기준(마스터 관리자 홈 「오늘 처리할 일」·알림에 올릴 때 쓴다)
export const INFRA_THRESHOLDS = { diskPct: 80, memPct: 90, dbConnPct: 80, backupMaxAgeHours: 36 } as const;

export type InfraMeasure = {
  takenAt: Date;
  instance: string;
  diskTotalBytes: number | null;
  diskUsedBytes: number | null;
  memTotalBytes: number | null;
  memUsedBytes: number | null;
  cpuCount: number | null;
  load1: number | null;
  dbSizeBytes: number | null;
  dbConnections: number | null;
  dbMaxConnections: number | null;
  backupLastAt: Date | null;
  backupCount: number | null;
  backupBytes: number | null;
};

const num = (v: string | undefined) => (v !== undefined && /^\d+$/.test(v.trim()) ? Number(v.trim()) : null);
const readText = (p: string) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return undefined;
  }
};

// 디스크: OPS_DISK_PATH(기본 /)가 있는 파일 시스템의 전체·사용량
async function measureDisk(): Promise<{ total: number | null; used: number | null }> {
  try {
    const s = await statfs(process.env.OPS_DISK_PATH || "/");
    return { total: s.blocks * s.bsize, used: (s.blocks - s.bfree) * s.bsize };
  } catch {
    return { total: null, used: null };
  }
}

// 메모리: 컨테이너 한도(cgroup v2)가 있으면 그 값, 없으면 서버 전체
function measureMemory(): { total: number; used: number } {
  const max = num(readText("/sys/fs/cgroup/memory.max"));
  const cur = num(readText("/sys/fs/cgroup/memory.current"));
  if (max !== null && cur !== null && max > 0 && max <= totalmem()) return { total: max, used: cur };
  return { total: totalmem(), used: totalmem() - freemem() };
}

// 백업: OPS_BACKUP_DIR(obs-*.dump)을 읽을 수 있을 때만. 앱 컨테이너에 마운트하지 않았으면 null(못 잼).
async function measureBackups(): Promise<{ lastAt: Date | null; count: number | null; bytes: number | null }> {
  const dir = process.env.OPS_BACKUP_DIR;
  if (!dir) return { lastAt: null, count: null, bytes: null };
  try {
    const names = (await readdir(dir)).filter((n) => n.startsWith("obs-") && n.endsWith(".dump"));
    const stats = await Promise.all(names.map((n) => stat(join(dir, n))));
    const last = stats.reduce<Date | null>((a, s) => (!a || s.mtime > a ? s.mtime : a), null);
    return { lastAt: last, count: names.length, bytes: stats.reduce((a, s) => a + s.size, 0) };
  } catch {
    return { lastAt: null, count: null, bytes: null };
  }
}

export async function measureInfra(db: Db, now = new Date()): Promise<InfraMeasure> {
  const [disk, backups, [row]] = await Promise.all([
    measureDisk(),
    measureBackups(),
    db.$queryRaw<{ size: bigint; conns: bigint; max: number }[]>`
      SELECT pg_database_size(current_database())::bigint AS size,
             (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database())::bigint AS conns,
             current_setting('max_connections')::int AS max`,
  ]);
  const mem = measureMemory();
  return {
    takenAt: now,
    instance: opsInstanceName(),
    diskTotalBytes: disk.total,
    diskUsedBytes: disk.used,
    memTotalBytes: mem.total,
    memUsedBytes: mem.used,
    cpuCount: availableParallelism(),
    load1: Math.round(loadavg()[0] * 100) / 100,
    dbSizeBytes: Number(row.size),
    dbConnections: Number(row.conns),
    dbMaxConnections: row.max,
    backupLastAt: backups.lastAt,
    backupCount: backups.count,
    backupBytes: backups.bytes,
  };
}

// 정기 실행 infra_snapshot.collect: 한 건 저장하고 보관 기간(35일)이 지난 것을 지운다. 저장한 수(1)를 돌려준다.
export async function collectInfraSnapshot(db: Db, now: Date): Promise<number> {
  const m = await measureInfra(db, now);
  await db.infraSnapshot.create({ data: m });
  await db.infraSnapshot.deleteMany({ where: { takenAt: { lt: new Date(now.getTime() - INFRA_SNAPSHOT_RETENTION_DAYS * 86_400_000) } } });
  return 1;
}

export type InfraSignal = { key: "disk" | "memory" | "dbConnections" | "backupStale"; level: "warning" | "critical"; value: number; threshold: number };

const pct = (used: number | null, total: number | null) => (used !== null && total ? Math.round((used / total) * 1000) / 10 : null);

// 기준 초과 신호: 디스크 80%·메모리 90%·DB 연결 80%·마지막 백업 36시간 초과. critical은 기준 +10%p(백업은 기준의 2배) 이상.
export function infraSignals(m: InfraMeasure): InfraSignal[] {
  const out: InfraSignal[] = [];
  const check = (key: InfraSignal["key"], value: number | null, threshold: number, criticalAt: number) => {
    if (value !== null && value >= threshold) out.push({ key, level: value >= criticalAt ? "critical" : "warning", value, threshold });
  };
  const t = INFRA_THRESHOLDS;
  check("disk", pct(m.diskUsedBytes, m.diskTotalBytes), t.diskPct, Math.min(t.diskPct + 10, 100));
  check("memory", pct(m.memUsedBytes, m.memTotalBytes), t.memPct, Math.min(t.memPct + 5, 100));
  check("dbConnections", pct(m.dbConnections, m.dbMaxConnections), t.dbConnPct, Math.min(t.dbConnPct + 10, 100));
  if (m.backupLastAt) {
    const ageH = Math.round(((m.takenAt.getTime() - m.backupLastAt.getTime()) / 3_600_000) * 10) / 10;
    check("backupStale", ageH, t.backupMaxAgeHours, t.backupMaxAgeHours * 2);
  }
  return out;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

// 최고관리자용 응답: 지금 잰 값(current)·기준 초과 신호·최근 snapshotHours시간 스냅숏(시간별). 바이트는 숫자, 못 잰 값은 null.
export async function infraStatus(db: PrismaClient, opts: { now?: Date; snapshotHours?: number } = {}) {
  const now = opts.now ?? new Date();
  const hours = Math.min(Math.max(opts.snapshotHours ?? 48, 1), INFRA_SNAPSHOT_RETENTION_DAYS * 24);
  const m = await measureInfra(db, now);
  const rows = await db.infraSnapshot.findMany({ where: { takenAt: { gte: new Date(now.getTime() - hours * 3_600_000) } }, orderBy: { takenAt: "asc" } });
  const view = (v: InfraMeasure) => ({
    takenAt: v.takenAt.toISOString(),
    instance: v.instance,
    disk: { totalBytes: v.diskTotalBytes, usedBytes: v.diskUsedBytes, usedPct: pct(v.diskUsedBytes, v.diskTotalBytes) },
    memory: { totalBytes: v.memTotalBytes, usedBytes: v.memUsedBytes, usedPct: pct(v.memUsedBytes, v.memTotalBytes) },
    cpu: { count: v.cpuCount, load1: v.load1 },
    db: { sizeBytes: v.dbSizeBytes, connections: v.dbConnections, maxConnections: v.dbMaxConnections, connectionsPct: pct(v.dbConnections, v.dbMaxConnections) },
    backup: { lastAt: iso(v.backupLastAt), count: v.backupCount, totalBytes: v.backupBytes },
  });
  const n = (b: bigint | null) => (b === null ? null : Number(b));
  return {
    checkedAt: now.toISOString(),
    thresholds: INFRA_THRESHOLDS,
    current: view(m),
    signals: infraSignals(m),
    snapshots: rows.map((r) =>
      view({ ...r, diskTotalBytes: n(r.diskTotalBytes), diskUsedBytes: n(r.diskUsedBytes), memTotalBytes: n(r.memTotalBytes), memUsedBytes: n(r.memUsedBytes), dbSizeBytes: n(r.dbSizeBytes), backupBytes: n(r.backupBytes) }),
    ),
  };
}
