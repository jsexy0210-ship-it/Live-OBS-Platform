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
// 아직 못 재는 것(앱 쪽 훅 필요, MASTER 요청): DB pool 사용량, worker·scheduler heartbeat, 작업 큐 적체.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

const state = { fails: {}, incidents: {}, warned: {}, alerts: [] };

function record(file, obj) {
  appendFileSync(`${cfg.dir}/${file}`, JSON.stringify(obj) + "\n");
}

async function alert(ev) {
  // 경고·장애와 복구만 보낸다(감시 시작 같은 정보성 사건은 기록만: 재시작 반복 때 알림 폭주 방지).
  if (!cfg.alertUrl || (ev.level === "info" && ev.kind !== "incident_close")) return;
  const now = Date.now();
  state.alerts = state.alerts.filter((t) => now - t < 3600_000);
  if (state.alerts.length >= cfg.alertMaxPerHour) return record("events.jsonl", { at: kst(), kind: "alert_suppressed", ref: ev.kind });
  state.alerts.push(now);
  try {
    await fetch(cfg.alertUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ev), signal: AbortSignal.timeout(5000) });
  } catch (e) {
    record("events.jsonl", { at: kst(), kind: "alert_failed", ref: ev.kind });
  }
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
  for (const t of cfg.targets) {
    const r = await probe(t);
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
  if (deployed && running && deployed !== running) await warnOnce(`version:${deployed}:${running}`, { kind: "version_mismatch", deployed, running }, 86400_000);

  let certDays = null;
  if (cfg.tlsHost) {
    certDays = await certDaysLeft(cfg.tlsHost);
    if (certDays === null) await warnOnce("tls:unreachable", { kind: "tls_unreachable", host: cfg.tlsHost });
    else if (certDays < cfg.tlsWarnDays) await warnOnce("tls:expiry", { kind: "tls_expiring", host: cfg.tlsHost, daysLeft: certDays }, 86400_000);
  }

  const status = { at, targets: results, openIncidents: Object.keys(state.incidents), deployedSha: deployed, runningVersion: running, certDaysLeft: certDays };
  writeFileSync(`${cfg.dir}/status.json`, JSON.stringify(status, null, 2) + "\n");
  writeFileSync(`${cfg.dir}/heartbeat.json`, JSON.stringify({ at, epochMs: Date.now(), intervalS: cfg.intervalS }) + "\n");
  return status;
}

async function main() {
  mkdirSync(cfg.dir, { recursive: true });
  await event({ level: "info", kind: "monitor_start", targets: cfg.targets.map((t) => t.name), intervalS: cfg.intervalS });
  for (;;) {
    try {
      const s = await tick();
      if (cfg.once) return console.log(JSON.stringify(s));
    } catch (e) {
      console.error(`[monitor] tick failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, cfg.intervalS * 1000));
  }
}

main();
