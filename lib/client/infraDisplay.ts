// MA-120 표시 전용: 장애 집계나 서버 임계값을 바꾸지 않는다
type Snapshot = { takenAt: string; disk: { usedPct: number | null }; memory: { usedPct: number | null }; cpu: { usedPct: number | null } };
export const CPU_LOAD_LABEL = "CPU 1분 부하(코어 대비)";
export const infraPercentText = (value: number | null) => value === null || !Number.isFinite(value) ? "—" : `${value}%`;

export function infraCollectionFailed(snapshot: Snapshot, current: boolean, checkedAt: number): boolean {
  const values = [snapshot.disk.usedPct, snapshot.memory.usedPct, snapshot.cpu.usedPct];
  return (!current && checkedAt - new Date(snapshot.takenAt).getTime() > 3 * 3_600_000)
    || values.every((value) => value === null || !Number.isFinite(value));
}

export function infraDisplayLevel(failed: number, critical: number, warning: number): "lost" | "crit" | "warn" | "ok" {
  return failed > 0 ? "lost" : critical > 0 ? "crit" : warning > 0 ? "warn" : "ok";
}
