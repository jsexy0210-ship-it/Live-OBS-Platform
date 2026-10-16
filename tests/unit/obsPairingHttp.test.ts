import { describe, expect, it } from "vitest";
import { pairingJson, pairingRoute } from "../../lib/server/obs/http";

const url = "https://test.example/api/obs/pairing/challenges";
function streamRequest(body: ReadableStream<Uint8Array>) {
  // Node fetch의 실제 스트림 Request. 가짜 시간으로 read/cancel microtask 순서를 감추지 않는다.
  const init: RequestInit & { duplex: "half" } = { method: "POST", body, duplex: "half" };
  return new Request(url, init);
}

describe("OBS bootstrap 실제 스트림 제한", () => {
  it("끝나지 않는 0byte pending read는 5초 뒤 408이고 발급 handler를 진행하지 않는다", async () => {
    let cancelled = false; let issued = false;
    const stream = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const route = pairingRoute(false, async req => {
      await pairingJson(req, []); issued = true; return Response.json({ issued });
    });
    const started = performance.now();
    const response = await route(streamRequest(stream));
    expect(response.status).toBe(408);
    expect(await response.json()).toEqual({ error: "obs_request_timeout" });
    expect(issued).toBe(false); expect(cancelled).toBe(true); expect(stream.locked).toBe(false);
    expect(performance.now() - started).toBeGreaterThanOrEqual(4900);
  }, 10_000);

  it("크기 초과는 underlying cancel promise가 끝나지 않아도 바로 413으로 거부한다", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(2049)); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    });
    const started = performance.now();
    await expect(pairingJson(streamRequest(stream), [])).rejects.toMatchObject({ status: 413, code: "obs_request_too_large" });
    expect(cancelled).toBe(true); expect(stream.locked).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  }, 2_000);
});
