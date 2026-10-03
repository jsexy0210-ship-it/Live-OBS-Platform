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
//   같은 사건은 한 번만, 시간당 MONITOR_ALERT_MAX_PER_HOUR건까지만 보낸다(알림 폭주 방지). 한도에 걸린 알림은 버리지 않고
//   남겨 두었다가 한도가 열리면 보낸다. 아직 못 나간 incident_open은 같은 대상의 incident_close와 합친다(openNotSent).
//   보낼 목록(최대 50건)이 넘치면 incident_close가 아닌 오래된 것부터 버린다.
//   받는 쪽이 2xx가 아니면 alert_failed를 남기고 한도를 쓰지 않은 채 다음 주기에 다시 보낸다(최대 5번).
//   전송은 동시 5건·틱마다 간격의 1/3 안에서만 해 감시 주기를 막지 않는다.
// 감시 상태(실패 횟수·열린 장애·경고 쿨다운·알림 한도·보낼 목록)는 monitor-state.json에 남겨 재시작해도 이어진다.
// 감시 대상에서 빠진 이름의 상태는 틱마다 지우고, 열린 장애는 incident_close(reason: target_removed)로 닫는다.
// 아직 못 재는 것(앱 쪽 훅 필요, MASTER 요청): DB pool 사용량, worker·scheduler heartbeat, 작업 큐 적체.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync, openSync, writeSync, fsyncSync, closeSync, renameSync, readdirSync, unlinkSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";

const env = (k, d) => process.env[k] ?? d;
// 숫자 설정: 비었으면 기본값, 숫자가 아니거나 최솟값보다 작으면 시작을 거부한다
// (간격 0·음수면 쉬지 않고 확인을 반복하고, 시간 제한 0이면 모든 확인이 바로 실패하기 때문).
// 간격·시간 제한에는 상한도 둔다: compose healthcheck가 heartbeat 120초 경과를 멈춤으로 보므로
// 한 틱(간격 ≤60초, 확인 ≤30초 + 알림 ≤간격/3)이 그 안에 끝나야 한다.
function num(k, d, min, { int = false, max = Infinity } = {}) {
  const raw = process.env[k];
  const v = raw === undefined || raw.trim() === "" ? d : Number(raw);
  if (!Number.isFinite(v) || v < min || v > max || (int && !Number.isInteger(v))) {
    console.error(`[monitor] ${k}=${JSON.stringify(raw)} 값이 올바르지 않아 시작하지 않아요(${int ? "정수, " : ""}${min} 이상${max < Infinity ? ` ${max} 이하` : ""}).`);
    process.exit(2);
  }
  return v;
}
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
  intervalS: num("MONITOR_INTERVAL_S", 15, 1, { max: 60 }),
  timeoutMs: num("MONITOR_TIMEOUT_MS", 5000, 100, { max: 30000 }),
  failThreshold: num("MONITOR_FAIL_THRESHOLD", 3, 1, { int: true }),
  // 배포 기록과 실행 버전이 이 횟수만큼 연속으로 다를 때만 경고(무중단 배포 중 잠깐 다른 것은 정상)
  versionMismatchTicks: num("MONITOR_VERSION_MISMATCH_TICKS", 3, 1, { int: true }),
  // 예전 단일 배포 진행 표시(호환). 지금 스크립트는 아래 폴더에 작업별 파일을 둔다. 유효한 표시가 있는 동안 새 장애·버전 불일치 경고를 미룬다.
  deployMark: env("MONITOR_DEPLOY_MARK", "/data/deploy-in-progress"),
  // 작업별 표시 파일 폴더(기본: 위 경로 + ".d")
  deployMarkDir: env("MONITOR_DEPLOY_MARK_DIR", `${env("MONITOR_DEPLOY_MARK", "/data/deploy-in-progress")}.d`),
  deployMarkStaleMin: num("MONITOR_DEPLOY_MARK_STALE_MIN", 15, 1),
  slowMs: num("MONITOR_SLOW_MS", 1000, 1),
  dir: env("MONITOR_DIR", "/data"),
  deployLog: env("MONITOR_DEPLOY_LOG", "/deploy-history.log"),
  tlsHost: env("MONITOR_TLS_HOST", ""),
  tlsWarnDays: num("MONITOR_TLS_WARN_DAYS", 14, 0),
  alertUrl: env("MONITOR_ALERT_URL", ""),
  alertMaxPerHour: num("MONITOR_ALERT_MAX_PER_HOUR", 10, 1, { int: true }),
  // 일별 표본 파일(samples-YYYYMMDD.jsonl)을 오늘 포함 며칠 치 남길지. 상태·사건·heartbeat 파일은 지우지 않는다.
  keepDays: num("MONITOR_KEEP_DAYS", 14, 1, { int: true, max: 3650 }),
  once: process.argv.includes("--once"),
};

const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600_000).toISOString().replace("Z", "+09:00");
const today = () => kst().slice(0, 10).replaceAll("-", "");

function probe({ url, host }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === "https:" ? https : http;
    const start = performance.now();
    // 결과는 한 번만 정한다. 헤더·본문 일부 뒤 연결이 끊기거나(aborted·error·close) 응답이 질질 끌려도
    // 전체 상한(timeoutMs)에서 실패로 끝나게 해 틱이 멈추지 않게 한다.
    let done = false;
    let req;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req?.destroy();
      resolve({ ms: Math.round(performance.now() - start), ...r });
    };
    const fail = (error) => finish({ status: 0, error });
    const timer = setTimeout(() => fail("timeout"), cfg.timeoutMs);
    req = lib.request(u, { method: "GET", timeout: cfg.timeoutMs, headers: host ? { host } : {} }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body.length < 4096 ? (body += c) : null));
      res.on("aborted", () => fail("network"));
      res.on("error", () => fail("network"));
      res.on("close", () => (res.complete ? null : fail("network")));
      res.on("end", () => {
        if (!res.complete) return fail("network");
        let j = {};
        try {
          j = JSON.parse(body);
        } catch {}
        finish({ status: res.statusCode, db: j.db ?? null, version: j.version ?? null });
      });
    });
    req.on("timeout", () => fail("timeout"));
    req.on("error", (e) => fail(e.message === "timeout" ? "timeout" : "network"));
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

// 감시 상태는 모두 /data/monitor-state.json 하나에 남겨, 감시를 다시 만들어도(가용성 on/off·재시작) 이어진다.
//   fails: 대상별 연속 실패 횟수 / incidents: 열린 장애(시작 시각) / mismatchTicks: 대상별 버전 불일치 연속 횟수
//   warned: 같은 경고의 마지막 시각(쿨다운) / alerts: 시간당 알림 한도에 쓴 전송 시각 / outbox: 보내지 못한 알림
// 파일이 없으면 빈 상태로, 깨졌으면 빈 상태로 시작하고 로그를 한 줄 남긴다.
const STATE_FILE = () => `${cfg.dir}/monitor-state.json`;
const emptyState = () => ({ fails: {}, incidents: {}, warned: {}, alerts: [], outbox: [], mismatchTicks: {} });
const ALERT_MAX_ATTEMPTS = 5;
const OUTBOX_MAX = 50;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);

function loadState() {
  const st = emptyState();
  try {
    const v = JSON.parse(readFileSync(STATE_FILE(), "utf8"));
    if (!isObj(v) || !isObj(v.fails) || !isObj(v.incidents) || !isObj(v.warned) || !isObj(v.mismatchTicks) || !Array.isArray(v.alerts) || !Array.isArray(v.outbox))
      throw new Error("형식이 맞지 않음");
    const now = Date.now();
    st.fails = v.fails;
    st.incidents = v.incidents;
    st.warned = v.warned;
    st.mismatchTicks = v.mismatchTicks;
    st.alerts = v.alerts.filter((t) => Number.isFinite(t) && now - t < 3600_000);
    st.outbox = v.outbox.filter((x) => isObj(x) && isObj(x.ev) && Number.isInteger(x.attempts) && x.attempts < ALERT_MAX_ATTEMPTS);
  } catch (e) {
    if (existsSync(STATE_FILE())) console.error(`[monitor] monitor-state.json을 읽지 못해 빈 상태로 시작해요: ${e instanceof Error ? e.message : String(e)}`);
  }
  return st;
}
// 같은 폴더의 임시 파일에 다 쓰고 fsync한 뒤 rename으로 바꿔 넣는다. 쓰는 도중 강제 종료돼도 이전 또는 새 상태 중 하나가 온전히 남는다.
function saveState() {
  const tmp = `${STATE_FILE()}.tmp`;
  const fd = openSync(tmp, "w");
  try {
    writeSync(fd, JSON.stringify(state) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, STATE_FILE());
  // rename 자체도 디스크에 남도록 폴더를 fsync한다.
  const dfd = openSync(cfg.dir, "r");
  try {
    fsyncSync(dfd);
  } finally {
    closeSync(dfd);
  }
}

let state = emptyState();

// 기록 쓰기가 실패해도(디스크 가득 참 등) 감시 주기·heartbeat·상태 저장을 막지 않는다. 실패는 로그로만 남긴다.
function record(file, obj) {
  try {
    appendFileSync(`${cfg.dir}/${file}`, JSON.stringify(obj) + "\n");
  } catch (e) {
    console.error(`[monitor] ${file} 기록 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// 보관 기간이 지난 일별 표본 파일을 지운다(날짜가 바뀔 때와 시작할 때 한 번).
let prunedFor = "";
function pruneSamples() {
  const day = today();
  if (day === prunedFor) return;
  prunedFor = day;
  const cutoff = kst(new Date(Date.now() - (cfg.keepDays - 1) * 86400_000)).slice(0, 10).replaceAll("-", "");
  try {
    for (const f of readdirSync(cfg.dir)) {
      const m = /^samples-(\d{8})\.jsonl$/.exec(f);
      if (m && m[1] < cutoff) unlinkSync(`${cfg.dir}/${f}`);
    }
  } catch (e) {
    console.error(`[monitor] 오래된 표본 정리 실패: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// 알림 한 건을 보낸다. 2xx가 아니거나 연결이 실패하면 ok=false.
async function send(ev, timeoutMs) {
  try {
    const res = await fetch(cfg.alertUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ev), signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer().catch(() => {});
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

// 보낼 알림을 보낸다. 감시 주기를 막지 않게 동시 ALERT_CONCURRENCY건, 틱마다 간격의 1/3 시간 안에서만 보내고
// 못 보낸 것은 다음 틱으로 넘긴다(시도 횟수도 그대로). 실패한 알림은 한도를 쓰지 않고 다음 틱에 다시(최대 ALERT_MAX_ATTEMPTS번).
const ALERT_CONCURRENCY = 5;
async function flushAlerts() {
  if (!cfg.alertUrl || state.outbox.length === 0) return;
  // 정수 밀리초로(AbortSignal.timeout은 정수만 받음: 간격이 3의 배수가 아니면 모든 전송이 RangeError로 실패했었음).
  const deadline = Date.now() + Math.floor((cfg.intervalS * 1000) / 3);
  const pending = [...state.outbox];
  const keep = [];
  while (pending.length && Date.now() < deadline - 100) {
    const now = Date.now();
    state.alerts = state.alerts.filter((t) => now - t < 3600_000);
    const slots = cfg.alertMaxPerHour - state.alerts.length;
    if (slots <= 0) {
      // 한도에 걸린 알림은 버리지 않고 남겨 두었다가 한도가 다시 열리는 틱에 보낸다(미룬 사실은 항목마다 한 번만 기록).
      for (const item of pending) {
        if (item.deferred) continue;
        item.deferred = true;
        record("events.jsonl", { at: kst(), kind: "alert_deferred", ref: item.ev.kind, target: item.ev.target ?? null });
      }
      break;
    }
    const batch = pending.splice(0, Math.min(ALERT_CONCURRENCY, slots));
    const timeoutMs = Math.max(100, Math.min(5000, Math.floor(deadline - now)));
    const results = await Promise.all(batch.map((item) => send(item.ev, timeoutMs)));
    for (const [k, item] of batch.entries()) {
      const r = results[k];
      if (r.ok) {
        state.alerts.push(Date.now());
        continue;
      }
      item.attempts += 1;
      record("events.jsonl", { at: kst(), kind: "alert_failed", ref: item.ev.kind, status: r.status, attempts: item.attempts });
      if (item.attempts < ALERT_MAX_ATTEMPTS) keep.push(item);
      else record("events.jsonl", { at: kst(), kind: "alert_dropped", ref: item.ev.kind });
    }
  }
  state.outbox = [...keep, ...pending]; // pending = 이번 틱 시간 안에 못 보낸 것
}

// 보낼 목록에 넣기만 한다. 실제 전송은 틱 끝에 한 번(flushAlerts) — 한 틱에 알림이 여러 건이어도 항목마다 시도는 1번.
async function alert(ev) {
  // 경고·장애와 복구만 보낸다(감시 시작 같은 정보성 사건은 기록만: 재시작 반복 때 알림 폭주 방지).
  if (!cfg.alertUrl || (ev.level === "info" && ev.kind !== "incident_close")) return;
  // 같은 대상의 incident_open이 아직 못 나갔으면(한도·전송 실패) close 하나로 합친다(close에 openedAt·durationS가 있어 정보가 줄지 않음).
  if (ev.kind === "incident_close") {
    for (let i = state.outbox.length - 1; i >= 0; i--) {
      const o = state.outbox[i].ev;
      if (o.target !== ev.target || (o.kind !== "incident_open" && o.kind !== "incident_close")) continue;
      if (o.kind === "incident_open") {
        state.outbox.splice(i, 1);
        ev = { ...ev, openNotSent: true };
      }
      break;
    }
  }
  state.outbox.push({ ev, attempts: 0 });
  trimOutbox();
}

// 보낼 목록이 상한을 넘으면 오래된 것부터 버리되 incident_close는 마지막까지 남긴다(복구 알림이 빠지지 않게).
function trimOutbox() {
  while (state.outbox.length > OUTBOX_MAX) {
    let i = state.outbox.findIndex((x) => x.ev.kind !== "incident_close");
    if (i < 0) i = 0;
    const [dropped] = state.outbox.splice(i, 1);
    record("events.jsonl", { at: kst(), kind: "alert_dropped", ref: dropped.ev.kind, target: dropped.ev.target ?? null });
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

// 감시 대상에서 빠진 이름(가용성 off로 빠진 app2 등)의 상태를 지운다. 열린 장애는 「대상 제외」로 닫는다.
async function pruneRemovedTargets() {
  const names = new Set(cfg.targets.map((t) => t.name));
  for (const [name, open] of Object.entries(state.incidents)) {
    if (names.has(name)) continue;
    delete state.incidents[name];
    await event({ level: "info", kind: "incident_close", target: name, reason: "target_removed", openedAt: open.openedKst, durationS: Math.round((Date.now() - open.openedAt) / 1000) });
  }
  for (const m of [state.fails, state.mismatchTicks]) for (const name of Object.keys(m)) if (!names.has(name)) delete m[name];
  // 대상별 경고 키: slow:<이름>, version:<이름>:...
  for (const key of Object.keys(state.warned)) {
    const [kind, name] = key.split(":");
    if ((kind === "slow" || kind === "version") && !names.has(name)) delete state.warned[key];
  }
}

// 유효한 배포 진행 표시 목록. 작업마다 자기 파일(deployMarkDir/<키>)을 두고, 하나라도 유효하면 배포 중이다.
// 유효: 만료 시각(expiresEpoch)이 지나지 않음. 종류가 kept(도는 동안 갱신하는 표시)거나 적혀 있지 않으면 마지막 갱신이 기준 시간
// (deployMarkStaleMin) 안이어야 한다. detached(deploy-mark.sh on, 갱신하는 프로세스 없음)는 만료 시각만 본다.
// 지난 파일(SIGKILL·재부팅으로 남은 고아)은 판단에서 빼고 지운 뒤 한 번 경고한다.
// .으로 시작하는 파일은 쓰는 도중의 임시 파일이라(키는 영문·숫자로 시작) 판단에서 빼고, 기준 시간이 지나면 지운다.
// 예전 단일 파일(deployMark)도 계속 읽는다(호환. 지난 것은 경고만 하고 그대로 둠).
async function activeDeployMarks() {
  const now = Date.now();
  const active = [];
  let names = [];
  try { names = readdirSync(cfg.deployMarkDir); } catch {}
  for (const f of names) {
    const p = `${cfg.deployMarkDir}/${f}`;
    try {
      const ageMin = (now - statSync(p).mtimeMs) / 60_000;
      const tmp = f.startsWith(".");
      const body = tmp ? "" : readFileSync(p, "utf8");
      const exp = Number(/^expiresEpoch=(\d+)$/m.exec(body)?.[1] ?? 0);
      const detached = /^kind=detached$/m.test(body);
      const expired = exp > 0 && now >= exp * 1000;
      const fresh = detached ? exp > 0 : ageMin <= cfg.deployMarkStaleMin;
      if (!tmp && fresh && !expired) { active.push(f); continue; }
      if (tmp && ageMin <= cfg.deployMarkStaleMin) continue;
      unlinkSync(p);
      if (!tmp) await event({ level: "warn", kind: "deploy_mark_stale", mark: f, ageMin: Math.round(ageMin), expired });
    } catch {}
  }
  try {
    const ageMin = (now - statSync(cfg.deployMark).mtimeMs) / 60_000;
    if (ageMin > cfg.deployMarkStaleMin) await warnOnce("deploy_mark_stale", { kind: "deploy_mark_stale", ageMin: Math.round(ageMin) }, 3600_000);
    else active.push("(legacy)");
  } catch {}
  return active;
}

async function tick() {
  await pruneRemovedTargets();
  const at = kst();
  const results = {};
  // 대상을 동시에 확인한다(여러 대상이 시간 초과여도 한 틱이 timeoutMs 정도로 끝나게).
  // 인증서 확인도 함께 돌린다(순서대로 하면 틱이 길어져 주기가 밀림).
  // 배포 중이면(표시 파일) 새 장애를 열지 않고(실패 횟수는 셈) 버전 불일치도 세지 않는다. 표시가 너무 오래 남으면(스크립트가 죽는 등) 따로 경고한다.
  // 표시는 탐침 전과 후에 모두 읽고, 둘 중 하나라도 배포 중이면 배포 중으로 본다(탐침 도중 배포가 끝나 표시가 사라져도 그 회차 실패로 장애를 열지 않음).
  const marksBefore = await activeDeployMarks();
  const [probed, certDays] = await Promise.all([Promise.all(cfg.targets.map((t) => probe(t))), cfg.tlsHost ? certDaysLeft(cfg.tlsHost) : Promise.resolve(null)]);
  const deployMarks = [...new Set([...marksBefore, ...(await activeDeployMarks())])];
  const deploying = deployMarks.length > 0;
  for (const [i, t] of cfg.targets.entries()) {
    const r = probed[i];
    const ok = r.status === 200 && r.db === "ok";
    results[t.name] = { ...r, ok };

    state.fails[t.name] = ok ? 0 : (state.fails[t.name] ?? 0) + 1;
    const open = state.incidents[t.name];
    // 배포 중에는 교체로 잠깐 실패해도 장애를 열지 않는다. 표시가 사라진 뒤에도 실패가 이어지면 다음 틱에 연다.
    if (!ok && !open && !deploying && state.fails[t.name] >= cfg.failThreshold) {
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

  if (cfg.tlsHost) {
    if (certDays === null) await warnOnce("tls:unreachable", { kind: "tls_unreachable", host: cfg.tlsHost });
    else if (certDays < cfg.tlsWarnDays) await warnOnce("tls:expiry", { kind: "tls_expiring", host: cfg.tlsHost, daysLeft: certDays }, 86400_000);
  }

  const status = { at, targets: results, openIncidents: Object.keys(state.incidents), deploying, deployMarks, deployedSha: deployed, runningVersion: running, versionMismatch, certDaysLeft: certDays };
  writeFileSync(`${cfg.dir}/status.json`, JSON.stringify(status, null, 2) + "\n");
  // heartbeat는 알림 전송과 상관없이 매 틱 먼저 남긴다.
  writeFileSync(`${cfg.dir}/heartbeat.json`, JSON.stringify({ at, epochMs: Date.now(), intervalS: cfg.intervalS }) + "\n");
  saveState();
  // 표본은 heartbeat·상태를 남긴 뒤에 쓴다(표본 쓰기가 실패해도 감시가 살아 있다는 신호는 남게).
  pruneSamples();
  for (const [name, r] of Object.entries(results)) record(`samples-${today()}.jsonl`, { at, target: name, ...r });
  await flushAlerts(); // 이번 틱의 새 알림 + 지난 틱에 실패한 알림(시간 상한 안에서)
  saveState();
  return status;
}

async function main() {
  mkdirSync(cfg.dir, { recursive: true });
  state = loadState();
  trimOutbox();
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
