import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = [process.cwd(), path.resolve(process.cwd(), "../.."), path.resolve(process.cwd(), "..")]
  .find((candidate) => {
    try { return existsSync(path.join(candidate, "design/project/PF-003.dc.html")); }
    catch { return false; }
  }) ?? process.cwd();
const designRoot = path.resolve(projectRoot, "design/project");
const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

export async function GET(_request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await context.params;
  if (segments.some((segment) => segment === "." || segment === "..")) return new Response(null, { status: 404 });
  const file = path.resolve(designRoot, ...segments);
  if (!file.startsWith(`${designRoot}${path.sep}`)) return new Response(null, { status: 404 });
  try {
    const body = await readFile(file);
    return new Response(body, { headers: { "content-type": contentTypes[path.extname(file)] ?? "application/octet-stream" } });
  } catch {
    return new Response(null, { status: 404 });
  }
}
