import { execFileSync } from "node:child_process";

// 검수 후보 신원 확인. PR 실행은 체크아웃(M)이 이벤트의 head(H)와 base(B)의 순수 병합인지,
// PR이 아닌 실행은 체크아웃이 이벤트 SHA인지 확인한다. 병합 시점의 최신성은 보증하지 않는다.
export type IdentityInput = {
  headSha: string; // git rev-parse HEAD
  parents: string[]; // HEAD의 부모
  headTree: string; // HEAD^{tree}
  githubSha: string | undefined;
  pr: { head: string; base: string } | null;
  mergeTree: string | null; // git merge-tree --write-tree base head 결과(실패하면 null)
};

export function identityProblems(i: IdentityInput): string[] {
  const out: string[] = [];
  if (!i.pr) {
    if (!i.githubSha || i.headSha !== i.githubSha) out.push("체크아웃(HEAD)이 GITHUB_SHA와 다릅니다.");
    return out;
  }
  if (i.githubSha !== i.headSha) out.push("체크아웃(HEAD)이 GITHUB_SHA와 다릅니다.");
  const want = [i.pr.head, i.pr.base].sort();
  const got = [...i.parents].sort();
  if (got.length !== 2 || got[0] !== want[0] || got[1] !== want[1]) out.push("병합 커밋의 부모가 {PR head, base}와 다릅니다.");
  if (!i.mergeTree) out.push("base와 head의 병합 트리를 다시 만들 수 없습니다.");
  else if (i.mergeTree !== i.headTree) out.push("체크아웃 트리가 base·head 병합 재계산 트리와 다릅니다.");
  return out;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export function readIdentity(pr: { head: string; base: string } | null): IdentityInput {
  let mergeTree: string | null = null;
  if (pr) {
    try { mergeTree = git("merge-tree", "--write-tree", pr.base, pr.head).split("\n")[0] || null; } catch { mergeTree = null; }
  }
  return {
    headSha: git("rev-parse", "HEAD"),
    parents: git("log", "-1", "--format=%P", "HEAD").split(" ").filter(Boolean),
    headTree: git("rev-parse", "HEAD^{tree}"),
    githubSha: process.env.GITHUB_SHA,
    pr,
    mergeTree,
  };
}
