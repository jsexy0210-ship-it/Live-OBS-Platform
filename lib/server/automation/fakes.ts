import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type {
  ActionOutcome,
  AutomationAction,
  AutomationPlanner,
  BrowserExecutor,
  BrowserSession,
  JobScope,
  JobSecrets,
  ObsBridge,
  Observation,
  PlannerDecision,
  PlannerInput,
  SecretVault,
} from "./ports";

// 가짜(모의) 구현. 실제 Gemini·브라우저·로컬 도구를 부르지 않는다. 운영 환경에서는 만들 수 없다.
function assertNotProduction(env: string | undefined) {
  if (env === "production") throw new Error("운영 환경에서는 자동 연결 가짜 구현을 쓸 수 없어요.");
}

const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

// 단계별 기본 행동 순서. 행동 하나마다 판단 비용 costWon을 쓴다.
const SCRIPT: Record<string, AutomationAction[]> = {
  shop_connect: [{ type: "navigate", url: "https://admin.cafe24.com/apps" }, { type: "click", target: "앱 설치" }, { type: "step_done" }],
  webhook_setup: [{ type: "fill", target: "주문 알림 주소", value: { secretRef: "webhook_url" } }, { type: "step_done" }],
  obs_overlay_install: [{ type: "obs_add_overlay_source" }, { type: "step_done" }],
  display_settings: [{ type: "obs_apply_display_settings" }, { type: "step_done" }],
  test_event_verify: [{ type: "send_test_event" }, { type: "check_overlay_shows_test_event" }, { type: "step_done" }],
};

export class FakePlanner implements AutomationPlanner {
  readonly model = "fake";
  readonly inputs: PlannerInput[] = [];
  // 테스트용: 특정 입력에서 다른 결정을 내게 한다(예: 화면의 악성 지시를 따른 결정)
  override: ((input: PlannerInput) => PlannerDecision | undefined) | null = null;

  constructor(
    private readonly costWon = 10,
    env: string | undefined = process.env.NODE_ENV,
  ) {
    assertNotProduction(env);
  }

  async decide(input: PlannerInput): Promise<PlannerDecision> {
    this.inputs.push(input);
    const o = this.override?.(input);
    if (o) return o;
    const script = SCRIPT[input.step.key] ?? [{ type: "step_done" }];
    return { action: script[Math.min(input.history.length, script.length - 1)], costWon: this.costWon };
  }
}

export class FakeBrowserExecutor implements BrowserExecutor {
  private seq = 0;
  readonly opened: { id: string; scope: JobScope }[] = [];
  readonly live = new Set<string>();
  // 세션별 쿠키 저장소. 세션끼리 나눠 쓰지 않는지 테스트가 확인한다.
  readonly cookies = new Map<string, Map<string, string>>();
  // 고객 행동 대기로 보관한 작업별 브라우저 상태(작업 id → 암호문). 작업 id를 추가 인증 데이터로 묶어 AES-256-GCM으로
  // 암호화한다. 같은 작업이 다시 열 때만 복원되고, discard 뒤에는 복원할 수 없다.
  readonly saved = new Map<string, string>();
  readonly discarded: string[] = [];
  private readonly stateKey = randomBytes(32);

  private seal(jobId: string, jar: Map<string, string>): string {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.stateKey, iv);
    c.setAAD(Buffer.from(jobId, "utf8"));
    const body = Buffer.concat([c.update(JSON.stringify([...jar]), "utf8"), c.final()]);
    return [iv, c.getAuthTag(), body].map((b) => b.toString("base64url")).join(".");
  }

  // 보관본을 그 작업 id로 푼다. 다른 작업 id·변조된 값이면 null(복원 거부).
  restoreBlob(jobId: string, blob: string): Map<string, string> | null {
    try {
      const [iv, tag, body] = blob.split(".").map((p) => Buffer.from(p, "base64url"));
      const d = createDecipheriv("aes-256-gcm", this.stateKey, iv);
      d.setAAD(Buffer.from(jobId, "utf8"));
      d.setAuthTag(tag);
      return new Map(JSON.parse(Buffer.concat([d.update(body), d.final()]).toString("utf8")) as [string, string][]);
    } catch {
      return null;
    }
  }

  async discard(scope: JobScope): Promise<void> {
    this.saved.delete(scope.jobId);
    // 행동 키 기록도 그 작업 것을 지운다
    for (const k of [...this.applied.keys()]) if (k.startsWith(`${scope.jobId}:`)) this.applied.delete(k);
    this.discarded.push(scope.jobId);
  }
  pageText: (scope: JobScope, secrets?: JobSecrets) => string = () => "Cafe24 관리자";
  // 관찰·현재 문서 주소(리다이렉트 흉내용). observe 때와 실행 직전 주소를 따로 바꿀 수 있다.
  pageUrl: (scope: JobScope) => string | null = () => "https://myshop.cafe24.com/disp/admin/shop1/";
  currentUrlOverride: ((scope: JobScope) => string | null) | null = null;
  // 이미 적용한 행동 키 → 결과(같은 키는 한 번만 적용)
  readonly applied = new Map<string, ActionOutcome>();
  // currentShopKey를 몇 번 읽었는지(재연결 대조 횟수 확인용)
  shopKeyReads = 0;
  // 판매자별로 연결된 쇼핑몰(기본: mall-<판매자 id>). 쇼핑몰 교체를 흉내 낼 때 바꾼다. null이면 알 수 없음.
  readonly shopKey = new Map<string, string | null>();
  // 실행한 행동(변경 행동이 몇 번 있었는지 테스트가 센다)
  readonly performed: { scope: JobScope; type: AutomationAction["type"] }[] = [];
  // 테스트용: 행동 결과를 바꾼다
  outcome: ((scope: JobScope, action: AutomationAction) => ActionOutcome | undefined) | null = null;

  constructor(
    private readonly delayMs = 0,
    env: string | undefined = process.env.NODE_ENV,
  ) {
    assertNotProduction(env);
  }

  async open(scope: JobScope): Promise<BrowserSession> {
    const id = `ctx-${++this.seq}`;
    this.opened.push({ id, scope });
    this.live.add(id);
    const blob = this.saved.get(scope.jobId);
    const jar = (blob && this.restoreBlob(scope.jobId, blob)) || new Map<string, string>();
    this.saved.delete(scope.jobId);
    this.cookies.set(id, jar);
    const self = this;
    let secretsSeen: JobSecrets | undefined;
    return {
      id,
      async observe(): Promise<Observation> {
        await sleep(self.delayMs);
        return { url: self.pageUrl(scope), text: self.pageText(scope, secretsSeen) };
      },
      async currentUrl() {
        return self.currentUrlOverride ? self.currentUrlOverride(scope) : self.pageUrl(scope);
      },
      async currentShopKey() {
        self.shopKeyReads++;
        const v = self.shopKey.get(scope.sellerId);
        return v === undefined ? `mall-${scope.sellerId}` : v;
      },
      async perform(action, secrets, actionKey?: string): Promise<ActionOutcome> {
        secretsSeen = secrets;
        // 같은 키로 이미 성공한 행동은 다시 적용하지 않는다(계약)
        const done = actionKey ? self.applied.get(actionKey) : undefined;
        if (done) return done;
        self.performed.push({ scope, type: action.type });
        await sleep(self.delayMs);
        const o = self.outcome?.(scope, action);
        if (o) return o;
        if (action.type === "navigate") jar.set("session", `${scope.sellerId}:${scope.jobId}`);
        const out: ActionOutcome =
          action.type === "step_done"
            ? { kind: "ok", stepDone: true, facts: { shopKey: self.shopKey.get(scope.sellerId) ?? `mall-${scope.sellerId}` } }
            : { kind: "ok", stepDone: false };
        if (actionKey) self.applied.set(actionKey, out);
        return out;
      },
      async close(opts) {
        self.live.delete(id);
        self.cookies.delete(id);
        if (opts?.keepForResume) self.saved.set(scope.jobId, self.seal(scope.jobId, jar));
      },
    };
  }
}

export class FakeObsBridge implements ObsBridge {
  // 로컬 도구가 연결되지 않은 판매자(고객 행동 LOCAL_TOOL 필요)
  readonly disconnected = new Set<string>();
  // 테스트 이벤트가 오버레이에 보이지 않는 판매자
  readonly notShowing = new Set<string>();
  readonly performed: { scope: JobScope; type: AutomationAction["type"] }[] = [];
  // 판매자별 OBS pairing(PC). 기본: pc-<판매자 id>. PC 교체를 흉내 낼 때 바꾼다. null이면 알 수 없음.
  readonly pairing = new Map<string, string | null>();

  constructor(
    private readonly delayMs = 0,
    env: string | undefined = process.env.NODE_ENV,
  ) {
    assertNotProduction(env);
  }

  async observe(scope: JobScope): Promise<Observation> {
    await sleep(this.delayMs);
    return { url: null, text: this.disconnected.has(scope.sellerId) ? "OBS 연결 안 됨" : "OBS 연결됨" };
  }

  // 지운 작업(OBS 연결 정보 삭제 요청을 받은 작업)
  readonly discarded: string[] = [];
  // 실패 흉내: 이 판매자의 OBS 행동은 처음 한 번 재시도 가능한 오류를 낸다
  readonly failOnce = new Set<string>();

  // 작업별로 로컬 도구가 들고 있는 OBS 연결 정보(연결 토큰). discard로 지운다.
  readonly connections = new Set<string>();

  async discard(scope: JobScope): Promise<void> {
    this.connections.delete(scope.jobId);
    for (const k of [...this.applied.keys()]) if (k.startsWith(`${scope.jobId}:`)) this.applied.delete(k);
    this.discarded.push(scope.jobId);
  }

  async currentPairingId(scope: JobScope): Promise<string | null> {
    if (this.disconnected.has(scope.sellerId)) return null;
    this.connections.add(scope.jobId);
    const v = this.pairing.get(scope.sellerId);
    return v === undefined ? `pc-${scope.sellerId}` : v;
  }

  // 이미 적용한 행동 키 → 결과, 판매자별 OBS 소스 수(같은 키는 한 번만 적용되는지 확인용)
  readonly applied = new Map<string, ActionOutcome>();
  readonly sources = new Map<string, number>();

  async perform(scope: JobScope, action: AutomationAction, actionKey?: string): Promise<ActionOutcome> {
    await sleep(this.delayMs);
    const done = actionKey ? this.applied.get(actionKey) : undefined;
    if (done) return done;
    const out = await this.apply(scope, action);
    if (out.kind === "ok" && actionKey) this.applied.set(actionKey, out);
    return out;
  }

  private async apply(scope: JobScope, action: AutomationAction): Promise<ActionOutcome> {
    this.performed.push({ scope, type: action.type });
    if (!this.disconnected.has(scope.sellerId)) this.connections.add(scope.jobId);
    if (action.type === "obs_add_overlay_source" && !this.disconnected.has(scope.sellerId) && !this.failOnce.has(scope.sellerId)) {
      this.sources.set(scope.sellerId, (this.sources.get(scope.sellerId) ?? 0) + 1);
    }
    if (this.failOnce.delete(scope.sellerId)) return { kind: "retryable", reason: "obs_busy" };
    if (this.disconnected.has(scope.sellerId)) return { kind: "needs_customer", action: "LOCAL_TOOL" };
    if (action.type === "check_overlay_shows_test_event") {
      if (this.notShowing.has(scope.sellerId)) return { kind: "ok", stepDone: false, verified: false };
      return { kind: "ok", stepDone: false, verified: true, evidence: { testEvent: `test-${scope.jobId}`, shownOnOverlay: true } };
    }
    if (action.type === "step_done") return { kind: "ok", stepDone: true, facts: { obsPairingId: this.pairing.get(scope.sellerId) ?? `pc-${scope.sellerId}` } };
    return { kind: "ok", stepDone: false };
  }
}

export class FakeSecretVault implements SecretVault {
  private readonly byJob = new Map<string, JobSecrets>();

  constructor(env: string | undefined = process.env.NODE_ENV) {
    assertNotProduction(env);
  }

  async forJob(scope: JobScope): Promise<JobSecrets> {
    let s = this.byJob.get(scope.jobId);
    if (!s) {
      s = { webhook_url: `https://hooks.test/${scope.sellerId}/${randomBytes(8).toString("hex")}`, webhook_secret: randomBytes(24).toString("hex") };
      this.byJob.set(scope.jobId, s);
    }
    return s;
  }
}
