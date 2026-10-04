import { afterAll, describe, expect, it } from "vitest";
import { db } from "./helpers";
import { GET } from "../../app/api/health/route";
import { prisma } from "../../lib/server/db";

afterAll(async () => {
  await db.$disconnect();
  await prisma.$disconnect();
});

describe("HTTP: 헬스 체크", () => {
  it("실제 DB에 SELECT 1이 되면 200", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ok", db: "ok" });
  });
});
