import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

// Migration 0169 revoked authenticated direct DML on these tables. That is only
// safe while no runtime code writes them directly.
const TABLES = [
  "sessions",
  "session_blocks",
  "session_block_areas",
  "electrolysis_entries",
  "laser_entries",
  "treatment_images",
] as const;

describe("0169 — the writer census it depends on is still zero", () => {
  // The revocation is only safe because no runtime code writes these tables.
  // If a writer ever comes back, this fails BEFORE the privilege change ships.
  const ROOTS = ["app", "lib", "components"];

  function sourceFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${name.name}`;
        if (name.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name.name)) out.push(p);
      }
    };
    for (const r of ROOTS) walk(r);
    return out;
  }

  function writerCount(table: string): number {
    let n = 0;
    for (const file of sourceFiles()) {
      const src = readFileSync(file, "utf8");
      const re = new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)`, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        let i = m.index + m[0].length;
        let depth = 0;
        let chain = "";
        while (i < src.length) {
          const ch = src[i];
          if ("([{".includes(ch)) depth++;
          else if (")]}".includes(ch)) depth--;
          else if (ch === ";" && depth <= 0) break;
          chain += ch;
          i++;
        }
        if (/\.(insert|update|delete|upsert)\s*\(/.test(chain)) n++;
      }
    }
    return n;
  }

  for (const t of TABLES) {
    it(`${t} has zero runtime direct writers`, () => {
      expect(writerCount(t)).toBe(0);
    });
  }

  it("the writer-guard exception list is still empty", () => {
    const guard = readFileSync("tests/security/entry-direct-dml-guard.test.ts", "utf8");
    expect(guard).toMatch(
      /const EXCEPTIONS: ReadonlyArray<\{ file: string; fn: string \}> = \[\];/,
    );
  });
});
