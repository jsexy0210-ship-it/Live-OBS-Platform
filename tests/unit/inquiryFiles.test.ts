import { describe, expect, it } from "vitest";
import { checkInquiryFile, cleanFileName, FILE_NAME_MAX, inquiryFileResponse } from "../../lib/server/platform-inquiries/files";

const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]);

describe("문의 첨부 파일 검사", () => {
  it("허용 확장자만(.txt·.log·.zip, 대소문자 무시), 사진·실행 형식·확장자 없음은 거부", () => {
    expect(checkInquiryFile("obs.TXT", Buffer.from("hello"))).toMatchObject({ ok: true, name: "obs.txt", contentType: "text/plain; charset=utf-8" });
    expect(checkInquiryFile("2026-10-06 방송.log", Buffer.from("로그"))).toMatchObject({ ok: true, name: "2026-10-06 방송.log" });
    expect(checkInquiryFile("logs.zip", zip)).toMatchObject({ ok: true, contentType: "application/zip" });
    for (const name of ["a.png", "a.jpg", "a.exe", "a.bat", "a.html", "a.svg", "a.js", "noext", ".txt", "a.txt.exe", "", null, 5]) {
      expect(checkInquiryFile(name, Buffer.from("x"))).toEqual({ ok: false, reason: "unsupported_file" });
    }
  });

  it("내용 검사: 빈 파일 거부, zip은 시그니처, 텍스트는 NUL이 있으면 거부(실행 파일을 .txt로 올려도 막힘)", () => {
    expect(checkInquiryFile("a.txt", Buffer.alloc(0)).ok).toBe(false);
    expect(checkInquiryFile("a.zip", Buffer.from("not a zip")).ok).toBe(false);
    expect(checkInquiryFile("a.zip", Buffer.from([0x50, 0x4b, 0x05, 0x06])).ok).toBe(true);
    expect(checkInquiryFile("a.txt", Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03])).ok).toBe(false);
    expect(checkInquiryFile("a.log", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00])).ok).toBe(false);
  });

  it("파일 이름: 경로·제어 문자·따옴표를 지우고 100자 안으로(확장자 유지)", () => {
    expect(cleanFileName("C:\\Users\\a\\obs.log")?.name).toBe("obs.log");
    expect(cleanFileName("../../etc/passwd.txt")?.name).toBe("passwd.txt");
    expect(cleanFileName('a"b\n<c>.txt')?.name).toBe("abc.txt");
    expect(cleanFileName("가".repeat(300) + ".zip")?.name).toHaveLength(FILE_NAME_MAX);
    expect(cleanFileName("가".repeat(300) + ".zip")?.name.endsWith(".zip")).toBe(true);
    expect(cleanFileName("...hidden.txt")?.name).toBe("hidden.txt");
  });

  it("내려받기는 attachment·nosniff·고정 content-type, 이름은 UTF-8로 안전하게", async () => {
    const res = inquiryFileResponse({ data: new Uint8Array([104, 105]), contentType: "text/plain; charset=utf-8", name: '방송 "로그".txt' });
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const cd = res.headers.get("content-disposition")!;
    expect(cd.startsWith("attachment;")).toBe(true);
    expect(cd).toContain("filename*=UTF-8''");
    expect(cd).not.toMatch(/filename="[^"]*"[^;]*"/);
    expect(await res.text()).toBe("hi");
    expect(inquiryFileResponse(null).status).toBe(404);
  });
});
