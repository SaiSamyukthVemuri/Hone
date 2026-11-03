import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG, type PermissionDef } from "@/lib/permissions/catalog";

// Insurance RW-1: a requirePermission call on a key that can be granted at the OWN (assigned) scope must name its target (a client, an
// appointment or a practitioner). Without one the engine cannot tell whose record this is, so an OWN-scope practitioner is refused on
// their own clients (fails closed, but wrongly). A TRIPWIRE, not a proof: it reads call text and cannot tell that the target named is the
// right one, only that one is named.

const OWN_KEYS = new Set((CATALOG as readonly PermissionDef[]).filter((d) => d.scopes.includes("own")).map((d) => d.key));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules" || n === ".next") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) ? [p] : [];
  });
}
const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");

/** Every requirePermission( ... ) call: its balanced argument text. */
export function callsIn(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\brequirePermission\s*\(/g)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}
const keyOf = (args: string) => args.match(/["']([a-z_]+\.[a-z_]+)["']/)?.[1];
const hasTarget = (args: string) => /\b(client|appointment|practitioner)\s*[:,}]/.test(args.slice(args.search(/["'][a-z_]+\.[a-z_]+["']/)));

// Calls that deliberately ask the studio-wide question (no single target exists), each with the reason.
const STUDIO_WIDE: Record<string, string> = {};

const FILES = ["app", "lib", "components"].flatMap(walk).filter((f) => !f.includes("lib/permissions/require-permission"));

describe("scoped keys are asked with their target (a tripwire)", () => {
  it("every requirePermission call on a key grantable at the OWN scope names a client, appointment or practitioner", () => {
    const bad: string[] = [];
    for (const f of FILES) {
      for (const args of callsIn(strip(readFileSync(f, "utf8")))) {
        const key = keyOf(args);
        if (!key || !OWN_KEYS.has(key)) continue;
        if (hasTarget(args)) continue;
        if (STUDIO_WIDE[`${f}::${key}`]) continue;
        bad.push(`${f}: requirePermission for ${key} names no client/appointment/practitioner target`);
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("the scan is alive and its parser works", () => {
    expect(OWN_KEYS.size).toBeGreaterThan(3);
    let calls = 0;
    for (const f of FILES) calls += callsIn(strip(readFileSync(f, "utf8"))).length;
    expect(calls).toBeGreaterThan(30);
    expect(callsIn('x(await requirePermission(await createClient(), s, "clin.view_records", { client: id }));')).toHaveLength(1);
    expect(hasTarget('db, s, "clin.view_records", { client: id }')).toBe(true);
    expect(hasTarget('db, s, "clin.view_records"')).toBe(false);
    expect(hasTarget('db, s, "clin.view_records", { client }')).toBe(true);
    expect(hasTarget('db, s, "appt.cancel", { appointment: a }')).toBe(true);
    // a target named only in the db expression before the key does not count
    expect(hasTarget('await clientFor(client), s, "clin.view_records"')).toBe(false);
  });

  it("no studio-wide exemption is stale", () => {
    expect(Object.keys(STUDIO_WIDE).length).toBe(0);
  });
});
