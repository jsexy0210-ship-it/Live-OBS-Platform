import type { PrismaClient } from "@prisma/client";
import { writeAudit } from "../audit/log";
import { dbNow, lockSellerAutomation } from "./queue";

// 쇼핑몰 연결 권한이 해제됐음을 기록한다(앱 삭제·권한 회수). 기록된 연결은 무료 재연결 대상이 아니다(확정 ②).
// TODO(외부 연동 단계): 쇼핑몰 앱 삭제·권한 회수 알림(웹훅)·정기 토큰 확인에서 이 함수를 부른다. 지금은 호출 경로가 없다.
// 감지 경로가 생기기 전에는 30일 안 같은 쇼핑몰·PC면 무료로 판정되므로 실제 판매를 열지 않는다(MASTER 검수 2026-10-04).
export async function markConnectionRevoked(db: PrismaClient, input: { sellerId: string; shopKey: string; reason: string }): Promise<number> {
  return db.$transaction(async (tx) => {
    // 무료 재연결 확정(commitJob)과 같은 판매자 잠금으로 순서를 맞춘다(해제 기록이 커밋되기 전에 무료 재연결이 확정되지 않게)
    await lockSellerAutomation(tx, input.sellerId);
    const now = await dbNow(tx);
    // 작업 상태와 무관하게 판매자·쇼핑몰 단위로 남긴다: 설치 작업이 아직 진행 중(RUNNING·VERIFYING)일 때 온 해제도
    // 그 작업이 끝난 뒤 무료 재연결 판정(decideReconnect)이 본다
    await tx.automationShopRevocation.upsert({
      where: { sellerId_shopKey: { sellerId: input.sellerId, shopKey: input.shopKey } },
      create: { sellerId: input.sellerId, shopKey: input.shopKey, revokedAt: now },
      update: { revokedAt: now },
    });
    const r = await tx.automationJob.updateMany({
      where: { sellerId: input.sellerId, shopKey: input.shopKey, status: "SUCCEEDED", connectionRevokedAt: null },
      data: { connectionRevokedAt: now },
    });
    await writeAudit(tx, {
      actorType: "SYSTEM",
      sellerId: input.sellerId,
      action: "automation.connection_revoked",
      targetType: "AutomationJob",
      after: { jobs: r.count, reason: input.reason.slice(0, 100) },
    });
    return r.count;
  });
}
