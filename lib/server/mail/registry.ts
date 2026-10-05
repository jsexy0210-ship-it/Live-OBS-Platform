import { isTestMode } from "../testMode";
import type { MailMessage, MailSender } from "./quota";

// 라우트가 쓰는 메일 공급자. 실제 메일 공급자(플랫폼 메일 서비스)는 대표님 승인 뒤 연결한다(CLAUDE.md 「유료 서비스」).
// - 운영: 공급자가 없으면 null(부르는 쪽이 「메일을 보낼 수 없습니다」로 처리하고 보낸 것으로 기록하지 않는다).
// - 개발·테스트·테스트 서버(OBS_TEST_MODE=1): 가짜 공급자(실제로 보내지 않고 sent에만 쌓는다).
export class FakeMailSender implements MailSender {
  readonly sent: (MailMessage & { idempotencyKey: string })[] = [];
  async send(message: MailMessage, opts: { idempotencyKey: string }) {
    this.sent.push({ ...message, idempotencyKey: opts.idempotencyKey });
    return { providerMessageId: `fake-${opts.idempotencyKey}` };
  }
}

const globalForMail = globalThis as unknown as { fakeMailSender?: FakeMailSender };

export function mailSender(env: NodeJS.ProcessEnv = process.env): MailSender | null {
  if (isTestMode(env) || env.NODE_ENV !== "production") {
    globalForMail.fakeMailSender ??= new FakeMailSender();
    return globalForMail.fakeMailSender;
  }
  return null;
}
