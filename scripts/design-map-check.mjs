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
const areas = { AU: 0, PF: 0, MA: 0, SA: 0, SH: 0, OV: 0, EM: 0, OG: 0 };
for (const l of rows) {
  const cells = l.split("|").map((s) => s.trim());
  const src = cells[4]; const status = cells[6];
  counts[status] = (counts[status] ?? 0) + 1;
  const area = cells[1].split("-")[0];
  areas[area] = (areas[area] ?? 0) + 1;
  if (src && src !== "—" && !existsSync(src)) broken.push(`${cells[1]} → ${src}`);
  if (cells[1] === "PF-003") {
    const legacy = "design/project/PF-003.dc.html";
    if (src !== "design/project/PF-003.dc.tsx" || cells[5] !== "PF-003.dc.tsx") broken.push("PF-003 canonical은 PF-003.dc.tsx여야 합니다");
    if (!existsSync(legacy) || !cells[9].includes("legacy 호환만") || !cells[9].includes(legacy)) broken.push("PF-003 legacy HTML은 보존된 호환 참조로만 표시해야 합니다");
  }
  if (!["FINAL", "DRAFT", "BLOCKED", "GROUP", "MISSING", "SUPERSEDED"].includes(status)) broken.push(`${cells[1]} 상태값 이상: ${status}`);
}
const mobileRows = map.split("\n").filter((line) => /^\| SA-\d{3}-M \|/.test(line));
for (const line of mobileRows) {
  const cells = line.split("|").map((s) => s.trim());
  const id = cells[1];
  if (cells[2] !== `design/project/${id}.dc.tsx` || cells[3] !== `${id}.dc.tsx` || !existsSync(cells[2])) broken.push(`${id}: TSX 정본 경로 오류`);
  if (cells[7] !== `design/project/${id}.dc.html` || !existsSync(cells[7])) broken.push(`${id}: 이행 HTML 보존 누락`);
}
// 등록 행과 상태 집계표를 함께 검증해 새 화면 추가 뒤 오래된 분모가 남지 않게 한다.
const summary = map.replace(/\r/g, "").split("## 집계\n")[1]?.split("## AU 공통 인증")[0] ?? "";
for (const [label, actual] of Object.entries({ ...areas, 합계: rows.length, FINAL: 0, DRAFT: 0, BLOCKED: 0, GROUP: 0, MISSING: 0, SUPERSEDED: 0, ...counts })) {
  const matches = [...summary.matchAll(new RegExp(`^\\| ${label} \\| (\\d+) \\|$`, "gm"))];
  if (matches.length !== 1 || Number(matches[0][1]) !== actual) broken.push(`집계 ${label}: 등록 행 ${actual} · 표 ${matches[0]?.[1] ?? "누락"}`);
}
console.log(`IA 화면 ID ${iaIds.size}개 · SCREEN_MAP 행 ${rows.length}개 · 상태 ${JSON.stringify(counts)}`);
console.log("PF-003 정본: design/project/PF-003.dc.tsx · legacy HTML은 호환 전용");
console.log(`IA에 있는데 MAP에 없는 화면: ${missingInMap.length}${missingInMap.length ? " → " + missingInMap.join(", ") : ""}`);
console.log(`깨진 경로: ${broken.length}${broken.length ? "\n  " + broken.join("\n  ") : ""}`);
process.exit(missingInMap.length || broken.length ? 1 : 0);
