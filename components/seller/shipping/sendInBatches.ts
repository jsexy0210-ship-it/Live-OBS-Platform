import { SHIPMENT_BATCH_MAX } from "../../../lib/server/orders/shipping";

export type BatchResult = { orderId: string; ok: boolean; error?: string; message?: string };

// 주문 목록을 서버 한도(SHIPMENT_BATCH_MAX)만큼씩 나눠 보내고 주문별 결과를 합친다.
// 묶음 하나가 통째로 실패하면(네트워크·400 등) 그 묶음의 주문은 실패로 남기고 다음 묶음은 계속 보낸다.
// post가 null을 주면 그 묶음 요청이 실패한 것이고, failMessage가 줄에 남길 사유다.
export async function sendInBatches<T>(
  list: T[],
  idOf: (x: T) => string,
  post: (chunk: T[]) => Promise<{ results: BatchResult[] } | { failMessage: string }>,
  size = SHIPMENT_BATCH_MAX,
): Promise<{ results: BatchResult[]; lastFail: string | null }> {
  const results: BatchResult[] = [];
  let lastFail: string | null = null;
  for (let i = 0; i < list.length; i += size) {
    const chunk = list.slice(i, i + size);
    const r = await post(chunk);
    if ("results" in r) results.push(...r.results);
    else {
      lastFail = r.failMessage;
      results.push(...chunk.map((x) => ({ orderId: idOf(x), ok: false, message: r.failMessage })));
    }
  }
  return { results, lastFail };
}
