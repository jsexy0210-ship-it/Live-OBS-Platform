import { describe, expect, it } from "vitest";
import { identityProblems, type IdentityInput } from "../e2e/candidateIdentity";

const H = "h".repeat(40), B = "b".repeat(40), M = "m".repeat(40), X = "x".repeat(40);
const T = "t".repeat(40);
const pr: IdentityInput = { headSha: M, parents: [B, H], headTree: T, githubSha: M, pr: { head: H, base: B }, mergeTree: T };

describe("PR 후보 신원", () => {
  it("순수 병합이면 통과한다(부모 순서 무관)", () => {
    expect(identityProblems(pr)).toEqual([]);
    expect(identityProblems({ ...pr, parents: [H, B] })).toEqual([]);
  });
  it("main이 움직여 H가 B를 포함하지 않아도(tree(M)!=tree(H)) 순수 병합이면 통과한다", () => {
    // 현재 검사는 tree(H)==tree(M)을 요구해 이 경우 실패했다. 신원은 부모와 재계산 트리로 확인한다.
    expect(identityProblems({ ...pr, headTree: "t2".repeat(20), mergeTree: "t2".repeat(20) })).toEqual([]);
  });
  it("부모 구성이 어긋나면 실패한다", () => {
    expect(identityProblems({ ...pr, parents: [B, X] })).not.toEqual([]);
    expect(identityProblems({ ...pr, parents: [H] })).not.toEqual([]);
    expect(identityProblems({ ...pr, parents: [B, H, X] })).not.toEqual([]);
  });
  it("재계산 트리가 다르면(순수 병합 아님) 실패한다", () => {
    expect(identityProblems({ ...pr, mergeTree: "u".repeat(40) })).not.toEqual([]);
  });
  it("재계산을 못 하면(충돌 등) 실패한다", () => {
    expect(identityProblems({ ...pr, mergeTree: null })).not.toEqual([]);
  });
  it("PR 실행에서 HEAD가 GITHUB_SHA와 다르면 실패한다", () => {
    expect(identityProblems({ ...pr, githubSha: X })).not.toEqual([]);
    expect(identityProblems({ ...pr, githubSha: undefined })).not.toEqual([]);
  });
  it("PR이 아닌 실행은 HEAD==GITHUB_SHA만 통과한다", () => {
    const push: IdentityInput = { headSha: M, parents: [X], headTree: T, githubSha: M, pr: null, mergeTree: null };
    expect(identityProblems(push)).toEqual([]);
    expect(identityProblems({ ...push, githubSha: X })).not.toEqual([]);
    expect(identityProblems({ ...push, githubSha: undefined })).not.toEqual([]);
  });
});
