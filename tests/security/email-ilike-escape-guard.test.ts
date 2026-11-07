import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// Source guard (Machines, 7 Nov 2026): `_` and `%` are wildcards in ILIKE, so an address typed by a user must never reach `.ilike` raw.
// Every `.ilike("<column containing email>", X)` in app/ and lib/ must pass X through escapeIlike(...) directly, or through a local
// constant that was initialised with escapeIlike(...). global-search's escapeIlike is pure and reusable (it imports nothing).

const ROOT = path.resolve(__dirname, "../..");
const SKIP = new Set(["node_modules", ".next", "types"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const CALL = /\.ilike\(\s*(["'`])([^"'`]*email[^"'`]*)\1\s*,\s*([^)]*(?:\([^)]*\))?[^)]*)\)/gi;

export function unescapedEmailIlike(src: string): string[] {
  const bad: string[] = [];
  for (const m of src.matchAll(CALL)) {
    const arg = m[3].trim();
    if (/^escapeIlike\(/.test(arg)) continue;
    const id = /^[A-Za-z_$][\w$]*$/.exec(arg)?.[0];
    if (id && new RegExp(`(?:const|let)\\s+${id}\\b[^=]*=\\s*escapeIlike\\(`).test(src)) continue;
    bad.push(`${m[2]} <- ${arg}`);
  }
  return bad;
}

describe("no unescaped .ilike on an email column in app/ and lib/", () => {
  it("every email ilike goes through escapeIlike", () => {
    const offenders: string[] = [];
    for (const f of [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "lib"))]) {
      for (const o of unescapedEmailIlike(readFileSync(f, "utf8"))) offenders.push(`${path.relative(ROOT, f)}: ${o}`);
    }
    expect(offenders).toEqual([]);
  });

  it("negative control: the detector flags raw uses and accepts the escaped forms", () => {
    expect(unescapedEmailIlike('q.ilike("email", normalized)')).toHaveLength(1);
    expect(unescapedEmailIlike("q.ilike('owner_email', value)")).toHaveLength(1);
    expect(unescapedEmailIlike('q.ilike("email", escapeIlike(normalized))')).toEqual([]);
    expect(unescapedEmailIlike('const pat = escapeIlike(x);\nq.ilike("email", pat)')).toEqual([]);
    expect(unescapedEmailIlike('q.ilike("name", pattern)')).toEqual([]);
  });
});
