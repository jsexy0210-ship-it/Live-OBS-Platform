import type { Playbook } from "../playbook";
import { cafe24Playbook } from "./cafe24";

// 저장소에 있는 작업서(현재 버전). 지원 목록에 오를지는 연습 기록으로 정한다(practice.ts supportedPlaybooks).
export const PLAYBOOKS: readonly Playbook[] = [cafe24Playbook];

export const findPlaybook = (id: string | null | undefined): Playbook | null => (id ? (PLAYBOOKS.find((p) => p.id === id) ?? null) : null);

// 쇼핑몰 주소로 작업서를 고른다(판매자는 플랫폼을 고르지 않는다). 모르는 주소면 null.
// 주소 문자열의 호스트 이름만 비교하고 그 주소에 접속하지 않는다(HTTP·DNS 요청 없음). 실제로 접속해 확인하는 기능을 만들면
// 정본 c4cc711의 내부 주소 차단(DNS 확인 뒤·리다이렉트마다 IP 재검사)을 같이 넣는다.
export function playbookForShopUrl(raw: string): Playbook | null {
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return null;
  }
  return PLAYBOOKS.find((p) => p.hostSuffixes.some((h) => host === h || host.endsWith(`.${h}`))) ?? null;
}
