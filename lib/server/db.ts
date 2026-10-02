import { PrismaClient } from "@prisma/client";

// 서버 전용. 개발 중 핫 리로드로 연결이 늘어나지 않게 전역에 하나만 둔다.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
