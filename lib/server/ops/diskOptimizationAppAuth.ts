import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";

export const DISK_ACTIONS_REPO = "jsexy0210-ship-it/Live-OBS-Platform";
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function fail(): never { throw new Error("ACTIONS_APP_AUTH_UNAVAILABLE"); }
const exactPermissions = (value: unknown) => {
  const p = object(value);
  return p.actions === "write" && p.contents === "read" && p.metadata === "read" && Object.keys(p).every(key => ["actions", "contents", "metadata"].includes(key));
};

/** 개인키는 서버 메모리에서만 사용한다. 설치 토큰은 저장소·권한·만료를 확인한 뒤 짧게 캐시한다. */
export class DiskAppInstallationToken {
  private readonly key: KeyObject;
  private cached: { value: string; expires: number } | null = null;
  private pending: Promise<string> | null = null;
  constructor(private readonly appId: string, private readonly installationId: string, pemBase64: string, private readonly clock: () => number = Date.now) {
    try {
      if (!/^[1-9][0-9]{0,19}$/.test(appId) || !/^[1-9][0-9]{0,19}$/.test(installationId) || !pemBase64 || pemBase64.length > 32_768) fail();
      const pem = Buffer.from(pemBase64, "base64");
      if (pem.toString("base64") !== pemBase64) fail();
      this.key = createPrivateKey(pem);
      if (this.key.asymmetricKeyType !== "rsa" || (this.key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) fail();
    } catch { fail(); }
  }
  invalidate() { this.cached = null; }
  async token(): Promise<string> {
    if (this.cached && this.cached.expires - this.clock() > 60_000) return this.cached.value;
    if (this.pending) return this.pending;
    this.pending = this.issue();
    try { return await this.pending; } finally { this.pending = null; }
  }
  private async request(method: "GET" | "POST", path: string, authorization: string, body?: unknown) {
    try {
      const response = await fetch(`https://api.github.com${path}`, { method, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000), headers: { authorization: `Bearer ${authorization}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.status !== (method === "POST" ? 201 : 200)) fail();
      return object(await response.json());
    } catch { return fail(); }
  }
  private async issue(): Promise<string> {
    this.cached = null;
    try {
      const now = Math.floor(this.clock() / 1000);
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const data = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: this.appId })}`;
      const jwt = `${data}.${sign("RSA-SHA256", Buffer.from(data), this.key).toString("base64url")}`;
      const installation = await this.request("GET", `/repos/${DISK_ACTIONS_REPO}/installation`, jwt);
      if (String(installation.id) !== this.installationId || String(installation.app_id) !== this.appId || installation.repository_selection !== "selected" || installation.suspended_at !== null || object(installation.account).login !== DISK_ACTIONS_REPO.split("/")[0] || !exactPermissions(installation.permissions)) fail();
      const token = await this.request("POST", `/app/installations/${this.installationId}/access_tokens`, jwt, { repositories: [DISK_ACTIONS_REPO.split("/")[1]], permissions: { actions: "write", contents: "read" } });
      const expires = typeof token.expires_at === "string" ? Date.parse(token.expires_at) : NaN;
      const repositories = Array.isArray(token.repositories) ? token.repositories : [];
      // 설치 토큰은 opaque 값이다. 신규 JWT형도 수용하되 헤더 주입·과도한 크기는 거부한다.
      if (typeof token.token !== "string" || token.token.length < 20 || token.token.length > 4096 || /[^A-Za-z0-9._~+\/=-]/.test(token.token) || !Number.isFinite(expires) || expires - this.clock() <= 60_000 || expires - this.clock() > 3_660_000 || !exactPermissions(token.permissions) || repositories.length !== 1 || object(repositories[0]).full_name !== DISK_ACTIONS_REPO) fail();
      this.cached = { value: token.token, expires };
      return this.cached.value;
    } catch { return fail(); }
  }
}

let configured: { signature: string; source: DiskAppInstallationToken } | null = null;
/** 설정 변경 시 새 issuer를 만들고 이전 키/토큰 캐시를 이용하지 않는다. 값/오류 원문 출력은 없다. */
export function configuredDiskAppToken(): DiskAppInstallationToken | null {
  const appId = process.env.ONQ_DISK_APP_ID ?? "", installationId = process.env.ONQ_DISK_INSTALLATION_ID ?? "", pem = process.env.ONQ_DISK_APP_PRIVATE_KEY_BASE64 ?? "";
  const signature = createHash("sha256").update(JSON.stringify([appId, installationId, pem])).digest("hex");
  if (configured?.signature === signature) return configured.source;
  configured = null;
  try { configured = { signature, source: new DiskAppInstallationToken(appId, installationId, pem) }; return configured.source; }
  catch { return null; }
}
