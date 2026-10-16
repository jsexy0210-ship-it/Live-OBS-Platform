import type { PrismaClient } from "@prisma/client";
import { noticeListHref } from "../../components/public/noticeView";
import { describe, expect, it, vi } from "vitest";
import { listPublicNoticesPage, parsePublicNoticePagination } from "../../lib/server/platform-notices/service";

describe("공개 공지 페이지 쿼리", () => {
  it("page와 pageSize가 없으면 1쪽·10건을 사용한다", () => {
    expect(parsePublicNoticePagination(null, null)).toEqual({ ok: true, page: 1, pageSize: 10 });
  });

  it("양의 정수 page와 pageSize를 받는다", () => {
    expect(parsePublicNoticePagination("3", "10")).toEqual({ ok: true, page: 3, pageSize: 10 });
  });

  it.each(["0", "-1", "1.5", "x", "9007199254740992"])("잘못된 page %s를 거부한다", (page) => {
    expect(parsePublicNoticePagination(page, null)).toEqual({ ok: false, reason: "invalid_page" });
  });

  it.each(["0", "-1", "1.5", "21", "x"])("잘못된 pageSize %s를 거부한다", (pageSize) => {
    expect(parsePublicNoticePagination("1", pageSize)).toEqual({ ok: false, reason: "invalid_page_size" });
  });
});


describe("공개 공지 끝 쪽 및 명시 크기 보존", () => {
  it("기본10 링크를 생략하고 명시5 링크는 상세·Back에 남긴다", () => {
    expect(noticeListHref({ page: 2, pageSize: 10 })).toBe("/notices?page=2");
    expect(noticeListHref({ category: "FEATURE", page: 2, pageSize: 5 })).toBe("/notices?category=FEATURE&page=2&pageSize=5");
    expect(parsePublicNoticePagination("1", "20")).toEqual({ ok: true, page: 1, pageSize: 20 });
  });
  it("자료 감소로 범위를 벗어난 번호는 실제 마지막 쪽의 offset으로 조회한다", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const count = vi.fn().mockResolvedValue(19);
    const db = { platformNotice: { count, findMany } } as unknown as PrismaClient;
    const result = await listPublicNoticesPage(db, 3, 10);
    expect(result).toMatchObject({ page: 2, pageSize: 10, total: 19, pageCount: 2, pinned: [] });
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 10, take: 10, where: expect.objectContaining({ isPinned: false }), orderBy: [{ publishedAt: "desc" }, { id: "desc" }] }));
  });
  it("일반 자료가 없어도 첫 쪽의 고정 공지 전체 조회를 유지한다", async () => {
    const findMany = vi.fn().mockResolvedValue([]);
    const db = { platformNotice: { count: vi.fn().mockResolvedValue(0), findMany } } as unknown as PrismaClient;
    const result = await listPublicNoticesPage(db, 9, 10);
    expect(result).toMatchObject({ page: 1, total: 0, pageCount: 0 });
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(findMany.mock.calls[1][0]).toMatchObject({ where: { isPinned: true } });
    expect(findMany.mock.calls[1][0]).not.toHaveProperty("take");
  });
});
