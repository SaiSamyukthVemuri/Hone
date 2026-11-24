import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Every spelling of the operator waitlist's URL path in application code comes from lib/waitlist/paths.ts. This fails if a new quoted waitlist route
// string appears in app/, components/ or lib/, so a later move of the queue changes one file. Comments are not code and are skipped; an `@/app/(app)/settings/waitlist/...`
// import specifier is a file path, not a URL, and does not start with the slash this guard looks for.

const ROOT = process.cwd();
const ALLOWED = new Set(["lib/waitlist/paths.ts"]);
const LITERAL = /["'`]\/(?:settings\/)?waitlist/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === "node_modules" || name === ".next") continue;
    const rel = `${dir}/${name}`;
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) walk(rel, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

function codeLines(src: string): string[] {
  let inBlock = false;
  const lines: string[] = [];
  for (const raw of src.split("\n")) {
    const t = raw.trim();
    if (inBlock) { if (t.includes("*/")) inBlock = false; continue; }
    if (t.startsWith("/*")) { if (!t.includes("*/")) inBlock = true; continue; }
    if (t.startsWith("//") || t.startsWith("*")) continue;
    lines.push(raw);
  }
  return lines;
}

describe("the waitlist path is spelled in one place", () => {
  const files = ["app", "components", "lib"].flatMap((d) => walk(d));
  it("scans a meaningful number of files", () => {
    expect(files.length).toBeGreaterThan(500);
  });
  it("no application file spells a quoted owner waitlist path outside lib/waitlist/paths.ts", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (ALLOWED.has(f)) continue;
      codeLines(readFileSync(join(ROOT, f), "utf8")).forEach((l) => { if (LITERAL.test(l)) offenders.push(`${f}: ${l.trim().slice(0, 100)}`); });
    }
    expect(offenders).toEqual([]);
  });
  it("NEGATIVE CONTROL: the detector catches every shape that used to occur", () => {
    for (const s of ['revalidatePath("/settings/waitlist");', "const A = '/settings/waitlist/replies';", "const h = `/settings/waitlist#entry-${id}`;", 'href="/settings/waitlist"'])
      expect(LITERAL.test(s)).toBe(true);
    expect(LITERAL.test('href="/waitlist"')).toBe(true);
    expect(LITERAL.test('import { x } from "@/app/(app)/settings/waitlist/actions";')).toBe(false);
  });
  it("the module itself is the one place, and has no imports", () => {
    const src = readFileSync(join(ROOT, "lib/waitlist/paths.ts"), "utf8");
    expect(src).toContain('export const WAITLIST_PATH = "/waitlist";');
    expect(src).not.toMatch(/^import /m);
  });
});
