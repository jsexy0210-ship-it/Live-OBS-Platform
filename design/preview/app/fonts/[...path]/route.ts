import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = [process.cwd(), path.resolve(process.cwd(), "../.."), path.resolve(process.cwd(), "..")]
  .find((candidate) => existsSync(path.join(candidate, "design/project/PF-003.dc.html"))) ?? process.cwd();

export async function GET(_request: Request, context: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await context.params;
  if (segments.some((segment) => segment === "." || segment === "..")) return new Response(null, { status: 404 });
  const fontRoot = path.resolve(root, "public/fonts");
  const file = path.resolve(fontRoot, ...segments);
  if (!file.startsWith(fontRoot + path.sep) || path.extname(file) !== ".woff2") return new Response(null, { status: 404 });
  try {
    const body = await readFile(file);
    return new Response(body, { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=3600" } });
  } catch {
    return new Response(null, { status: 404 });
  }
}
