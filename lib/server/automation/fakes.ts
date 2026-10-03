import { randomBytes } from "node:crypto";
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
  // 고객 행동 대기로 보관한 작업별 쿠키(작업 id → 쿠키). 같은 작업이 다시 열 때만 복원한다.
  readonly saved = new Map<string, Map<string, string>>();
  pageText: (scope: JobScope, secrets?: JobSecrets) => string = () => "Cafe24 관리자";
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
    const jar = this.saved.get(scope.jobId) ?? new Map<string, string>();
    this.saved.delete(scope.jobId);
    this.cookies.set(id, jar);
    const self = this;
    let secretsSeen: JobSecrets | undefined;
    return {
      id,
      async observe(): Promise<Observation> {
        await sleep(self.delayMs);
        return { url: "https://admin.cafe24.com/", text: self.pageText(scope, secretsSeen) };
      },
      async currentShopKey() {
        const v = self.shopKey.get(scope.sellerId);
        return v === undefined ? `mall-${scope.sellerId}` : v;
      },
      async perform(action, secrets): Promise<ActionOutcome> {
        secretsSeen = secrets;
        self.performed.push({ scope, type: action.type });
        await sleep(self.delayMs);
        const o = self.outcome?.(scope, action);
        if (o) return o;
        if (action.type === "navigate") jar.set("session", `${scope.sellerId}:${scope.jobId}`);
        if (action.type === "step_done") return { kind: "ok", stepDone: true, facts: { shopKey: self.shopKey.get(scope.sellerId) ?? `mall-${scope.sellerId}` } };
        return { kind: "ok", stepDone: false };
      },
      async close(opts) {
        self.live.delete(id);
        self.cookies.delete(id);
        if (opts?.keepForResume) self.saved.set(scope.jobId, jar);
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

  async currentPairingId(scope: JobScope): Promise<string | null> {
    if (this.disconnected.has(scope.sellerId)) return null;
    const v = this.pairing.get(scope.sellerId);
    return v === undefined ? `pc-${scope.sellerId}` : v;
  }

  async perform(scope: JobScope, action: AutomationAction): Promise<ActionOutcome> {
    await sleep(this.delayMs);
    this.performed.push({ scope, type: action.type });
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
