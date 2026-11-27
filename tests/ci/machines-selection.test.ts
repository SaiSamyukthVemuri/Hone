import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import path from "node:path";
// @ts-expect-error - .mjs utilities ship without type declarations
import { selectBrowserGroups, specsForGroups, BROWSER_GROUPS, EXTENDED } from "../../scripts/browser-groups.mjs";

// CI-SELECT-01. lib/machines/**, components/machines/** and the Settings -> Machines page select the `sessions` group instead of falling to the
// unattributed extended fail-safe. This file proves the mapping by SELECTION and by the real IMPORT GRAPH, so it cannot narrow coverage as the
// code grows.
type Sel = { groups: string[]; extended: boolean; reason: string };
const sel = (...files: string[]) => selectBrowserGroups(files) as Sel;

describe("machines code selects its own group, not the whole suite", () => {
  it("the MultiPlex load reducer selects sessions + smoke and never extended", () => {
    const s = sel("lib/machines/multiplex-load.ts");
    expect(s.extended).toBe(false);
    expect(s.groups).toEqual(["sessions", "smoke"]);
    // and the specs that drive the machine form are in the selected set
    const specs = specsForGroups(s.groups) as string[];
    for (const spec of ["xcell-multiplex-visit.spec.ts", "multiplex-no-machine.spec.ts", "machine-real-3g.spec.ts"]) expect(specs).toContain(spec);
  });

  it("the machines components and the Settings -> Machines page select sessions + smoke", () => {
    for (const f of ["components/machines/machine-first-setup-connected.tsx", "app/(app)/settings/machines/page.tsx"]) {
      const s = sel(f);
      expect(s.extended, f).toBe(false);
      expect(s.groups, f).toEqual(["sessions", "smoke"]);
    }
  });

  it("FAIL-SAFE: the two machine modules the client page and the export also import stay unattributed, so they still run extended", () => {
    for (const f of ["lib/machines/legacy-machine.ts", "lib/machines/profile-contract.ts"]) {
      expect(sel(f).extended, f).toBe(true);
      expect(sel(f).groups, f).toEqual([EXTENDED]);
    }
  });

  it("FAIL-SAFE: an unattributed file beside a machines file still selects extended (the per-file check is not cancelled)", () => {
    expect(sel("lib/machines/multiplex-load.ts", "lib/export/resource-registry.ts").extended).toBe(true);
  });

  it("FAIL-SAFE: a NEW file under lib/machines is mapped by directory, so nothing under it is unattributed", () => {
    expect(sel("lib/machines/brand-new-module.ts").groups).toEqual(["sessions", "smoke"]);
  });
});

// -- the import-graph proof -----------------------------------------------------------------------------------------------------------------
const ROOT = process.cwd();
const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(path.relative(ROOT, p));
  }
  return out;
};
const resolveImport = (from: string, spec: string): string | null => {
  const base = spec.startsWith("@/") ? path.join(ROOT, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(path.join(ROOT, from)), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (existsSync(c) && statSync(c).isFile()) return path.relative(ROOT, c);
  return null;
};

describe("the mapping is proved against the real import graph", () => {
  const files = ["app", "components", "lib"].flatMap((d) => walk(path.join(ROOT, d)).map((f) => (path.isAbsolute(f) ? path.relative(ROOT, f) : f)));
  const importers = new Map<string, Set<string>>();
  for (const f of files) {
    const src = readFileSync(path.join(ROOT, f), "utf8");
    for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
      const r = resolveImport(f, m[1]!);
      if (r) (importers.get(r) ?? importers.set(r, new Set()).get(r)!).add(f);
    }
  }
  const routesReaching = (target: string): string[] => {
    const seen = new Set([target]);
    const queue = [target];
    const routes = new Set<string>();
    while (queue.length) {
      const x = queue.pop()!;
      if (/^app\//.test(x)) routes.add(x);
      for (const i of importers.get(x) ?? []) if (!seen.has(i)) { seen.add(i); queue.push(i); }
    }
    return [...routes];
  };
  const mapped = files.filter(
    (f) => (/^lib\/machines\//.test(f) && !/^lib\/machines\/(legacy-machine|profile-contract)\.ts$/.test(f)) || /^components\/machines\//.test(f),
  );

  it("finds the mapped files (the walk is not vacuous)", () => {
    expect(mapped.length).toBeGreaterThan(30);
    expect(routesReaching("lib/machines/multiplex-load.ts").length).toBeGreaterThan(0);
  });

  it("every app route that reaches a mapped file is itself attributed, and selects ONLY sessions + smoke", () => {
    const offenders: string[] = [];
    for (const f of mapped) {
      for (const r of routesReaching(f)) {
        const s = sel(r);
        if (s.extended || !s.groups.every((g) => g === "sessions" || g === "smoke")) offenders.push(`${f} <- ${r}: ${s.extended ? "extended (unattributed route)" : s.groups.join("+")}`);
      }
    }
    expect(offenders, "a route that is NOT covered by the sessions group now imports a mapped machines file: map it, or take the file out of the rule").toEqual([]);
  });

  it("the two excluded modules really do reach a route that no group covers (the exclusion is still needed)", () => {
    for (const f of ["lib/machines/legacy-machine.ts", "lib/machines/profile-contract.ts"]) {
      expect(routesReaching(f).some((r) => sel(r).extended), f).toBe(true);
    }
  });

  it("sessions is a real group that holds the machine specs", () => {
    expect(Object.keys(BROWSER_GROUPS)).toContain("sessions");
  });
});
