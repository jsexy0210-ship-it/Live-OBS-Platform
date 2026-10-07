// design/SCREEN_MAP.md 검사: 소스 경로 존재 · docs/IA.md 화면 ID 누락 0 · 상태 집계
import { readFileSync, existsSync } from "node:fs";
const map = readFileSync("design/SCREEN_MAP.md", "utf8");
const ia = readFileSync("docs/IA.md", "utf8");
const idRe = /\b(AU|PF|MA|SA|SH|OV|EM|OG)-\d{3}(?:-[A-Za-z0-9]+)*\b/g;
const iaIds = new Set(ia.match(idRe) ?? []);
// 화면 행만(9열 표). 「IA 밖 보드」 3열 표는 제외한다.
const rows = map.split("\n").filter((l) => /^\| (AU|PF|MA|SA|SH|OV|EM|OG)-\d{3}/.test(l) && l.split("|").length >= 10);
const mapIds = new Set(rows.map((l) => l.split("|")[1].trim()));
const missingInMap = [...iaIds].filter((id) => !mapIds.has(id)).sort();
const broken = [];
const counts = {};
for (const l of rows) {
  const cells = l.split("|").map((s) => s.trim());
  const src = cells[4]; const status = cells[6];
  counts[status] = (counts[status] ?? 0) + 1;
  if (src && src !== "—" && !existsSync(src)) broken.push(`${cells[1]} → ${src}`);
  if (cells[1] === "PF-003") {
    const legacy = "design/project/PF-003.dc.html";
    if (src !== "design/project/PF-003.dc.tsx" || cells[5] !== "PF-003.dc.tsx") broken.push("PF-003 canonical은 PF-003.dc.tsx여야 합니다");
    if (!existsSync(legacy) || !cells[9].includes("legacy 호환만") || !cells[9].includes(legacy)) broken.push("PF-003 legacy HTML은 보존된 호환 참조로만 표시해야 합니다");
  }
  if (!["FINAL", "DRAFT", "BLOCKED", "GROUP", "MISSING", "SUPERSEDED"].includes(status)) broken.push(`${cells[1]} 상태값 이상: ${status}`);
}
console.log(`IA 화면 ID ${iaIds.size}개 · SCREEN_MAP 행 ${rows.length}개 · 상태 ${JSON.stringify(counts)}`);
console.log("PF-003 정본: design/project/PF-003.dc.tsx · legacy HTML은 호환 전용");
console.log(`IA에 있는데 MAP에 없는 화면: ${missingInMap.length}${missingInMap.length ? " → " + missingInMap.join(", ") : ""}`);
console.log(`깨진 경로: ${broken.length}${broken.length ? "\n  " + broken.join("\n  ") : ""}`);
process.exit(missingInMap.length || broken.length ? 1 : 0);
