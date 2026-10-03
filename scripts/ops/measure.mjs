#!/usr/bin/env node
// 가용성 측정(테스트 서버 전용). 정해진 속도로 요청을 보내 가용률·오류율·p50/p95/p99·장애 구간·복구 시간을 잰다.
// 외부 패키지 없이 Node 22로 돈다. 서버에는 Node가 없으니 measure.sh가 node 컨테이너로 실행한다.
// 사용: node measure.mjs --url http://127.0.0.1/api/health --duration 60 --rps 20 [--timeout 3000] [--out 결과.json] [--label 이름]
// 성공 기준: HTTP 200. 그 밖의 상태·연결 실패·시간 초과는 실패로 센다.
// 「장애 구간」은 gapMs(기본 2초) 안에 이어진 실패를 묶은 것, 「복구 시간」은 구간 첫 실패부터 마지막 실패 뒤 첫 성공까지다.
// 큐 적체: 아직 작업 큐가 없어 재지 않는다(작업 큐가 생기면 --queue-url로 적체 수를 함께 읽게 넓힌다).
import { writeFileSync } from "node:fs";

// 숫자 옵션 범위. 무한대·숫자 아님·범위 밖이면 요청을 하나도 보내지 않고 종료 코드 2로 끝낸다.
const LIMITS = { duration: [0, 600], rps: [0, 200], timeout: [1, 60000], gapMs: [0, 60000] }; // duration·rps는 0 초과

class ArgError extends Error {}

function args(argv) {
  const out = { url: "http://127.0.0.1/api/health", duration: 60, rps: 20, timeout: 3000, out: "", label: "", gapMs: 2000 };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, "");
    if (!(k in out)) throw new ArgError(`모르는 옵션: ${argv[i]}`);
    if (argv[i + 1] === undefined) throw new ArgError(`${argv[i]} 값이 없어요.`);
    out[k] = typeof out[k] === "number" ? Number(argv[i + 1]) : argv[i + 1];
  }
  for (const [k, [min, max]] of Object.entries(LIMITS)) {
    const v = out[k];
    const okMin = k === "duration" || k === "rps" ? v > min : v >= min;
    if (!Number.isFinite(v) || !okMin || v > max) throw new ArgError(`--${k} 값이 올바르지 않아요(${k === "duration" || k === "rps" ? "0 초과" : `${min} 이상`} ${max} 이하): ${v}`);
  }
  return out;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null);
const round = (n) => (n === null ? null : Math.round(n * 10) / 10);

async function one(url, timeout, t0) {
  const start = performance.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { "cache-control": "no-store" } });
    await res.arrayBuffer();
    return { t: start - t0, ms: performance.now() - start, status: res.status, ok: res.status === 200 };
  } catch (e) {
    const kind = e?.name === "TimeoutError" ? "timeout" : "network";
    return { t: start - t0, ms: performance.now() - start, status: 0, ok: false, error: kind };
  }
}

export function summarize(results, opt) {
  const sorted = [...results].sort((a, b) => a.t - b.t);
  const ok = sorted.filter((r) => r.ok).length;
  const lat = sorted.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  const byStatus = {};
  for (const r of sorted) {
    const k = r.ok ? "200" : r.error ?? String(r.status);
    byStatus[k] = (byStatus[k] ?? 0) + 1;
  }
  // 장애 구간: 실패와 실패 사이가 gapMs 이하이면 한 구간으로 묶는다(앱 2개에 번갈아 보내면 실패가 띄엄띄엄 나므로).
  // 복구 시간 = 구간의 첫 실패 요청 시각 → 마지막 실패 뒤 처음 성공한 요청 시각(없으면 측정 끝까지 미복구).
  const gapMs = opt.gapMs ?? 2000;
  const outages = [];
  let cur = null;
  for (const r of sorted) {
    if (r.ok) continue;
    if (cur && r.t - cur.lastMs <= gapMs) {
      cur.failures += 1;
      cur.lastMs = r.t;
    } else {
      if (cur) outages.push(cur);
      cur = { startMs: r.t, lastMs: r.t, failures: 1 };
    }
  }
  if (cur) outages.push(cur);
  for (const o of outages) {
    const next = sorted.find((r) => r.ok && r.t > o.lastMs);
    o.recoveryMs = next ? next.t - o.startMs : null;
  }
  const total = sorted.length;
  return {
    label: opt.label || null,
    url: opt.url,
    durationS: opt.duration,
    rps: opt.rps,
    total,
    ok,
    availabilityPct: total ? round((ok / total) * 100 * 1000) / 1000 : null,
    errorRatePct: total ? round(((total - ok) / total) * 100 * 1000) / 1000 : null,
    byStatus,
    latencyMs: { p50: round(pct(lat, 50)), p95: round(pct(lat, 95)), p99: round(pct(lat, 99)), max: round(lat.at(-1) ?? null) },
    outages: outages.map((o) => ({ startS: round(o.startMs / 1000), failures: o.failures, recoveryS: o.recoveryMs === null ? null : round(o.recoveryMs / 1000) })),
    longestRecoveryS: outages.length ? round(Math.max(...outages.map((o) => o.recoveryMs ?? Infinity)) / 1000) : 0,
    unrecovered: outages.some((o) => o.recoveryMs === null),
    queueBacklog: "not_measured",
  };
}

async function main() {
  const opt = args(process.argv.slice(2));
  const t0 = performance.now();
  const pending = [];
  const results = [];
  let n = 0;
  const startedAt = new Date().toISOString();
  // 보낼 요청 수를 정수로 먼저 정하고(부동소수 오차로 1건 더 나가지 않게) 그만큼만 보낸다.
  const total = Math.max(1, Math.round(opt.duration * opt.rps));
  for (; n < total; ) {
    const due = t0 + (n * 1000) / opt.rps;
    const wait = due - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    n += 1;
    pending.push(one(opt.url, opt.timeout, t0).then((r) => results.push(r)));
  }
  await Promise.all(pending);
  const summary = { startedAt, ...summarize(results, opt) };
  const text = JSON.stringify(summary, null, 2);
  if (opt.out) writeFileSync(opt.out, text + "\n");
  console.log(text);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(e instanceof ArgError ? 2 : 1);
  });
}
