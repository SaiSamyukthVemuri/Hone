import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// PR #268 ("chart parts"): NO copied Jane assets. Source-grep, no DB/network.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("no copied Jane assets (inspiration only)", () => {
  // Walk app/, components/, lib/, docs/ and assert no Jane CDN/thumbnail URL or
  // image path is referenced. The product-category word "Jane" (import-source
  // label, competitor copy, 'not copied' framing) is allowed; copied ASSETS are
  // not.
  function walk(dir: string): string[] {
    const out: string[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(join(process.cwd(), dir));
    } catch {
      return out;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".next") continue;
      const rel = join(dir, name);
      const st = statSync(join(process.cwd(), rel));
      if (st.isDirectory()) out.push(...walk(rel));
      else if (/\.(ts|tsx|md|mdx)$/.test(name)) out.push(rel);
    }
    return out;
  }

  const files = [
    ...walk("app"),
    ...walk("components"),
    ...walk("lib"),
    ...walk("docs"),
  ];

  it("references no jane.app URL or Jane /thumbs/ asset path anywhere", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = read(f);
      if (/jane\.app/i.test(src) || /\/thumbs\//i.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
