#!/usr/bin/env node
// 서버 감시 수집기(ONQ 단계 6 인프라 몫). 앱·화면과 따로 도는 compose 서비스(obs-web-monitor, profile monitor)로 실행한다.
// 외부 패키지 없이 Node 22로 돈다. 비밀값을 읽지 않는다(.env를 마운트하지 않음).
//
// 하는 일(MONITOR_INTERVAL_S마다):
//   1) 대상마다 GET → 상태 코드·응답 시간·db·version 기록(health 응답 시간에는 DB SELECT 1 시간이 들어 있다)
//   2) 연속 실패 MONITOR_FAIL_THRESHOLD번 → incident open, 다시 성공 → incident close(지속 시간)
//   3) 느림(MONITOR_SLOW_MS 초과)·배포 기록과 실행 버전 불일치·인증서 만료 임박 → warn
//   4) 자기 heartbeat(heartbeat.json)를 매번 남긴다 → 감시가 끊겼는지 바깥에서 알 수 있다
// 기록: MONITOR_DIR/samples-YYYYMMDD.jsonl(표본), events.jsonl(사건), status.json(마지막 상태), heartbeat.json
// 알림: 채널이 미정이라 인터페이스만 둔다. MONITOR_ALERT_URL이 있으면 사건을 JSON으로 POST하고, 없으면 기록만 한다.
//   같은 사건은 한 번만, 시간당 MONITOR_ALERT_MAX_PER_HOUR건까지만 보낸다(알림 폭주 방지).
//   받는 쪽이 2xx가 아니면 alert_failed를 남기고 한도를 쓰지 않은 채 다음 주기에 다시 보낸다(최대 5번).
// 아직 못 재는 것(앱 쪽 훅 필요, MASTER 요청): DB pool 사용량, worker·scheduler heartbeat, 작업 큐 적체.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

const env = (k, d) => process.env[k] ?? d;
const cfg = {
  // "이름=주소" 쉼표 구분. 주소 끝 "#호스트"는 Host 헤더로 보낸다(프록시의 http://127.0.0.1 블록에 맞추기).
  targets: env("MONITOR_TARGETS", "app=http://obs-web-app:3000/api/health,proxy=http://obs-web-proxy/api/health#127.0.0.1")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [name, rest] = s.split("=");
      const [url, host] = rest.split("#");
      return { name, url, host };
    }),
  intervalS: Number(env("MONITOR_INTERVAL_S", "15")),
  timeoutMs: Number(env("MONITOR_TIMEOUT_MS", "5000")),
  failThreshold: Number(env("MONITOR_FAIL_THRESHOLD", "3")),
  // 배포 기록과 실행 버전이 이 횟수만큼 연속으로 다를 때만 경고(무중단 배포 중 잠깐 다른 것은 정상)
  versionMismatchTicks: Number(env("MONITOR_VERSION_MISMATCH_TICKS", "3")),
  // 배포 진행 표시(rolling-deploy.sh·rollback-app.sh가 만들고 끝나면 지움). 있는 동안 버전 불일치 경고를 미룬다.
  deployMark: env("MONITOR_DEPLOY_MARK", "/data/deploy-in-progress"),
  deployMarkStaleMin: Number(env("MONITOR_DEPLOY_MARK_STALE_MIN", "15")),
  slowMs: Number(env("MONITOR_SLOW_MS", "1000")),
  dir: env("MONITOR_DIR", "/data"),
  deployLog: env("MONITOR_DEPLOY_LOG", "/deploy-history.log"),
  tlsHost: env("MONITOR_TLS_HOST", ""),
  tlsWarnDays: Number(env("MONITOR_TLS_WARN_DAYS", "14")),
  alertUrl: env("MONITOR_ALERT_URL", ""),
  alertMaxPerHour: Number(env("MONITOR_ALERT_MAX_PER_HOUR", "10")),
  once: process.argv.includes("--once"),
};

const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600_000).toISOString().replace("Z", "+09:00");
const today = () => kst().slice(0, 10).replaceAll("-", "");

function probe({ url, host }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const start = performance.now();
    const req = lib.request(u, { method: "GET", timeout: cfg.timeoutMs, headers: host ? { host } : {} }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body.length < 4096 ? (body += c) : null));
      res.on("end", () => {
        let j = {};
        try {
          j = JSON.parse(body);
        } catch {}
        resolve({ status: res.statusCode, ms: Math.round(performance.now() - start), db: j.db ?? null, version: j.version ?? null });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => resolve({ status: 0, ms: Math.round(performance.now() - start), error: e.message === "timeout" ? "timeout" : "network" }));
    req.end();
  });
}

// "호스트" 또는 "호스트:포트"(기본 443)
function certDaysLeft(target) {
  const [host, port = "443"] = target.split(":");
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: Number(port), servername: host, timeout: cfg.timeoutMs }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c?.valid_to ? Math.floor((new Date(c.valid_to).getTime() - Date.now()) / 86400_000) : null);
    });
    // 핸드셰이크가 멈춰도 결과를 돌려준다(안 그러면 tick이 영원히 멈춰 heartbeat가 끊김).
    s.on("timeout", () => {
      s.destroy();
      resolve(null);
    });
    s.on("error", () => resolve(null));
    s.on("close", () => resolve(null));
  });
}

function lastDeployedSha() {
  if (!existsSync(cfg.deployLog)) return null;
  const m = [...readFileSync(cfg.deployLog, "utf8").matchAll(/sha=([0-9a-f]{40})/g)];
  return m.length ? m.at(-1)[1] : null;
}

// 시간당 알림 한도 기록. 감시를 다시 만들어도(가용성 on/off·재시작) 한도가 이어지게 /data에 남긴다.
const ALERT_WINDOW_FILE = () => `${cfg.dir}/alert-window.json`;
function loadAlertWindow() {
  try {
    const v = JSON.parse(readFileSync(ALERT_WINDOW_FILE(), "utf8"));
    if (!Array.isArray(v) || !v.every((t) => Number.isFinite(t))) throw new Error("형식이 맞지 않음");
    return v.filter((t) => Date.now() - t < 3600_000);
  } catch (e) {
    if (existsSync(ALERT_WINDOW_FILE())) console.error(`[monitor] alert-window.json을 읽지 못해 빈 목록으로 시작해요: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}
function saveAlertWindow() {
  writeFileSync(ALERT_WINDOW_FILE(), JSON.stringify(state.alerts) + "\n");
}

const state = { fails: {}, incidents: {}, warned: {}, alerts: [], outbox: [], mismatchTicks: {} };
const ALERT_MAX_ATTEMPTS = 5;
const OUTBOX_MAX = 50;

function record(file, obj) {
  appendFileSync(`${cfg.dir}/${file}`, JSON.stringify(obj) + "\n");
}

// 알림 한 건을 보낸다. 2xx가 아니거나 연결이 실패하면 false.
async function send(ev) {
  try {
    const res = await fetch(cfg.alertUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ev), signal: AbortSignal.timeout(5000) });
    await res.arrayBuffer().catch(() => {});
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

// 보낼 알림을 차례로 보낸다. 실패한 알림은 시간당 한도를 쓰지 않고 다음 주기에 다시 보낸다(최대 ALERT_MAX_ATTEMPTS번).
async function flushAlerts() {
  if (!cfg.alertUrl) return;
  const rest = [];
  for (const item of state.outbox) {
    const now = Date.now();
    state.alerts = state.alerts.filter((t) => now - t < 3600_000);
    if (state.alerts.length >= cfg.alertMaxPerHour) {
      record("events.jsonl", { at: kst(), kind: "alert_suppressed", ref: item.ev.kind });
      continue;
    }
    const r = await send(item.ev);
    if (r.ok) {
      state.alerts.push(now);
      saveAlertWindow();
      continue;
    }
    item.attempts += 1;
    record("events.jsonl", { at: kst(), kind: "alert_failed", ref: item.ev.kind, status: r.status, attempts: item.attempts });
    if (item.attempts < ALERT_MAX_ATTEMPTS) rest.push(item);
    else record("events.jsonl", { at: kst(), kind: "alert_dropped", ref: item.ev.kind });
  }
  state.outbox = rest;
}

// 보낼 목록에 넣기만 한다. 실제 전송은 틱 끝에 한 번(flushAlerts) — 한 틱에 알림이 여러 건이어도 항목마다 시도는 1번.
async function alert(ev) {
  // 경고·장애와 복구만 보낸다(감시 시작 같은 정보성 사건은 기록만: 재시작 반복 때 알림 폭주 방지).
  if (!cfg.alertUrl || (ev.level === "info" && ev.kind !== "incident_close")) return;
  state.outbox.push({ ev, attempts: 0 });
  if (state.outbox.length > OUTBOX_MAX) record("events.jsonl", { at: kst(), kind: "alert_dropped", ref: state.outbox.shift().ev.kind });
}

async function event(ev) {
  const e = { at: kst(), ...ev };
  record("events.jsonl", e);
  console.log(JSON.stringify(e));
  await alert(e);
}

// 같은 경고는 key마다 cooldownMs에 한 번만.
async function warnOnce(key, ev, cooldownMs = 3600_000) {
  const last = state.warned[key] ?? 0;
  if (Date.now() - last < cooldownMs) return;
  state.warned[key] = Date.now();
  await event({ level: "warn", ...ev });
}

async function tick() {
  const at = kst();
  const results = {};
  // 대상을 동시에 확인한다(여러 대상이 시간 초과여도 한 틱이 timeoutMs 정도로 끝나게).
  const probed = await Promise.all(cfg.targets.map((t) => probe(t)));
  for (const [i, t] of cfg.targets.entries()) {
    const r = probed[i];
    const ok = r.status === 200 && r.db === "ok";
    results[t.name] = { ...r, ok };
    record(`samples-${today()}.jsonl`, { at, target: t.name, ...r, ok });

    state.fails[t.name] = ok ? 0 : (state.fails[t.name] ?? 0) + 1;
    const open = state.incidents[t.name];
    if (!ok && !open && state.fails[t.name] >= cfg.failThreshold) {
      state.incidents[t.name] = { openedAt: Date.now(), openedKst: at };
      await event({ level: "critical", kind: "incident_open", target: t.name, status: r.status, error: r.error ?? null, db: r.db ?? null });
    } else if (ok && open) {
      delete state.incidents[t.name];
      await event({ level: "info", kind: "incident_close", target: t.name, openedAt: open.openedKst, durationS: Math.round((Date.now() - open.openedAt) / 1000) });
    }
    if (ok && r.ms > cfg.slowMs) await warnOnce(`slow:${t.name}`, { kind: "slow", target: t.name, ms: r.ms }, 600_000);
  }

  const deployed = lastDeployedSha();
  const running = Object.values(results).find((r) => r.ok && r.version)?.version ?? null;
  // 배포 중이면(표시 파일) 불일치를 세지 않는다. 표시가 너무 오래 남으면(스크립트가 죽는 등) 따로 경고한다.
  let deploying = false;
  try {
    const ageMin = (Date.now() - statSync(cfg.deployMark).mtimeMs) / 60_000;
    // 기준 시간이 지난 표시(SIGKILL·재부팅으로 남은 것)는 배포 중으로 보지 않는다. 파일은 그대로 두고 판단에서만 뺀다.
    if (ageMin > cfg.deployMarkStaleMin) await warnOnce("deploy_mark_stale", { kind: "deploy_mark_stale", ageMin: Math.round(ageMin) }, 3600_000);
    else deploying = true;
  } catch {}
  // healthy인 대상마다 따로 비교한다(앱 하나만 보면 다른 앱이 옛 이미지로 떠 있어도 못 잡음). 연속 틱도 대상마다 센다.
  const versionMismatch = {};
  for (const [name, r] of Object.entries(results)) {
    if (deploying || !deployed || !r.ok || !r.version || r.version === deployed) {
      state.mismatchTicks[name] = 0;
      continue;
    }
    const ticks = (state.mismatchTicks[name] = (state.mismatchTicks[name] ?? 0) + 1);
    versionMismatch[name] = { running: r.version, ticks };
    if (ticks >= cfg.versionMismatchTicks)
      await warnOnce(`version:${name}:${deployed}:${r.version}`, { kind: "version_mismatch", target: name, deployed, running: r.version, ticks }, 86400_000);
  }

  let certDays = null;
  if (cfg.tlsHost) {
    certDays = await certDaysLeft(cfg.tlsHost);
    if (certDays === null) await warnOnce("tls:unreachable", { kind: "tls_unreachable", host: cfg.tlsHost });
    else if (certDays < cfg.tlsWarnDays) await warnOnce("tls:expiry", { kind: "tls_expiring", host: cfg.tlsHost, daysLeft: certDays }, 86400_000);
  }

  const status = { at, targets: results, openIncidents: Object.keys(state.incidents), deployedSha: deployed, runningVersion: running, versionMismatch, certDaysLeft: certDays };
  writeFileSync(`${cfg.dir}/status.json`, JSON.stringify(status, null, 2) + "\n");
  writeFileSync(`${cfg.dir}/heartbeat.json`, JSON.stringify({ at, epochMs: Date.now(), intervalS: cfg.intervalS }) + "\n");
  await flushAlerts(); // 이번 틱의 새 알림 + 지난 틱에 실패한 알림을 한 번에
  return status;
}

async function main() {
  mkdirSync(cfg.dir, { recursive: true });
  state.alerts = loadAlertWindow();
  await event({ level: "info", kind: "monitor_start", targets: cfg.targets.map((t) => t.name), intervalS: cfg.intervalS });
  // 고정 주기: 확인에 걸린 시간만큼 다음 틱까지 기다리는 시간을 줄인다.
  for (;;) {
    const started = Date.now();
    try {
      const s = await tick();
      if (cfg.once) return console.log(JSON.stringify(s));
    } catch (e) {
      console.error(`[monitor] tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, Math.max(0, cfg.intervalS * 1000 - (Date.now() - started))));
  }
}

main();
