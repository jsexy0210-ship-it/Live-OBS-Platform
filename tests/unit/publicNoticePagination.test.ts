import { describe, expect, it } from "vitest";
import { parsePublicNoticePagination } from "../../lib/server/platform-notices/service";

describe("공개 공지 페이지 쿼리", () => {
  it("page와 pageSize가 없으면 1쪽·5건을 사용한다", () => {
    expect(parsePublicNoticePagination(null, null)).toEqual({ ok: true, page: 1, pageSize: 5 });
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
