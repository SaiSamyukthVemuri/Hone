import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
// @ts-expect-error - .mjs utilities ship without type declarations
import { selectBrowserGroups, deriveGroupsFromGraph, specsForGroups, BROWSER_GROUPS, EXTENDED } from "../../scripts/browser-groups.mjs";
// @ts-expect-error - .mjs utilities ship without type declarations
import { buildImportGraph, reachingEntries, isEntry } from "../../scripts/import-graph.mjs";

// CI-SELECT-02. An application file that no path rule names is attributed from the ENTRY POINTS that can execute it (page, route, layout,
// middleware...), when every one of those entries is itself attributed. This file pins the behaviour, every fail-safe, and re-proves the
// derivation against the real import graph with a SECOND, independent walk, so the mapping cannot narrow coverage as the code grows.
// Declared before any suite reads them: describe callbacks run during collection, and a const read before its declaration is a TDZ error
// under strict ESM (this toolchain's transform happens to hoist it, which is why it did not fail; do not rely on that).
const ROOT = process.cwd();
const SOURCE_ROOTS = ["app", "components", "lib", "hooks"];
const walk = (dir: string, out: string[] = []): string[] => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".next") continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(path.relative(ROOT, p).split(path.sep).join("/"));
  }
  return out;
};
const resolveImport = (from: string, spec: string): string | null => {
  const base = spec.startsWith("@/") ? path.join(ROOT, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(path.join(ROOT, from)), spec) : null;
  if (!base) return null;
  for (const c of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (existsSync(c) && statSync(c).isFile()) return path.relative(ROOT, c).split(path.sep).join("/");
  return null;
};

type Sel = { groups: string[]; extended: boolean; reason: string };
const sel = (...files: string[]) => selectBrowserGroups(files) as Sel;

describe("Analytics and the Desk select their own groups; the Dashboard and Checkout are deliberately not narrowed", () => {
  it("the Analytics screens and what only they import select owner_admin", () => {
    for (const f of ["app/(app)/financials/analytics/charts.tsx", "app/(app)/financials/analytics/page.tsx", "lib/business-analytics/chart-geometry.ts"]) {
      const s = sel(f);
      expect(s.extended, f).toBe(false);
      expect(s.groups, f).toEqual(["owner_admin", "smoke"]);
    }
    expect(specsForGroups(sel("app/(app)/financials/analytics/charts.tsx").groups)).toContain("statements-month-navigation.spec.ts");
  });

  it("the Dashboard is NOT narrowed: thirty-one specs in six groups land on it, so it and everything only it reaches stay extended", () => {
    for (const f of ["app/(app)/dashboard/page.tsx", "app/(app)/dashboard/practice-snapshot.tsx", "lib/dashboard/attention-card.ts"]) {
      expect(sel(f).extended, f).toBe(true);
    }
  });

  it("Checkout stays extended too (the dashboard reaches it); its own browser coverage is the payment lane, selected by the payment rule", () => {
    for (const f of ["app/(app)/quick-checkout-actions.ts", "components/quick-checkout-modal.tsx", "lib/billing/quick-checkout.ts"]) {
      expect(sel(f).extended, f).toBe(true);
    }
  });

  it("the Desk route selects calendar + booking", () => {
    expect(sel("app/(desk)/desk/page.tsx").groups).toEqual(["booking", "calendar", "smoke"]);
  });
});

describe("FAIL-SAFE: anything the graph cannot prove still runs the extended suite", () => {
  it("a component hosted by an UNAUDITED route is extended: its specs may live in another group (consultation-notes-card, clinical-notes.spec.ts)", () => {
    // components/consultation-notes-card.tsx is imported only by the calendar's appointment page, yet e2e/clinical-notes.spec.ts (sessions) drives it.
    expect(sel("components/consultation-notes-card.tsx").extended).toBe(true);
    expect(sel("app/(app)/calendar/[id]/page.tsx").extended).toBe(false);
  });
  it("every selector module, alone or beside a narrow file, selects EXTENDED (a non-empty selection runs targeted and full_matrix does not widen it)", () => {
    for (const m of ["scripts/import-graph.mjs", "scripts/browser-groups.mjs", "scripts/classify-changes.mjs", "scripts/test-dependencies.mjs"]) {
      expect(sel(m).extended, m).toBe(true);
      expect(sel(m, "app/(app)/calendar/CalendarToolbar.tsx").extended, `${m} + calendar file`).toBe(true);
      expect(sel("lib/business-analytics/chart-geometry.ts", m).extended, `${m} + analytics file`).toBe(true);
    }
  });
  it("shared infrastructure beside a graph-derived file is still extended", () => {
    expect(sel("lib/business-analytics/chart-geometry.ts", "lib/supabase/server.ts").extended).toBe(true);
    expect(sel("lib/business-analytics/chart-geometry.ts", "e2e/helpers/seed.ts").extended).toBe(true);
  });
  it("an unattributed file beside a derived one is not cancelled by it", () => {
    expect(sel("lib/business-analytics/chart-geometry.ts", "lib/finance/client-statement-read.ts").extended).toBe(true);
  });
  it("a file the graph does not contain (deleted, or not TypeScript) is extended", () => {
    expect(sel("lib/business-analytics/no-such-file.ts").extended).toBe(true);
    expect(sel("lib/business-analytics/fixture-data.json").extended).toBe(true);
  });

  const fixture = (files: Record<string, string>) => {
    const root = mkdtempSync(path.join(tmpdir(), "graph-"));
    for (const [f, src] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      writeFileSync(path.join(root, f), src);
    }
    return root;
  };
  const derive = (root: string, f: string) => deriveGroupsFromGraph(f, root) as Set<string> | null;

  it("derives the union of the groups of every entry that reaches the file", () => {
    const root = fixture({
      "lib/shared.ts": "export const a = 1;",
      "app/(desk)/desk/page.tsx": 'import { a } from "@/lib/shared"; export default a;',
      "app/(app)/financials/analytics/page.tsx": 'import { a } from "@/lib/shared"; export default a;',
    });
    expect([...derive(root, "lib/shared.ts")!].sort()).toEqual(["booking", "calendar", "owner_admin"]);
  });
  it("is transitive through intermediate modules and dynamic imports", () => {
    const root = fixture({
      "lib/leaf.ts": "export const a = 1;",
      "lib/mid.ts": 'export * from "./leaf";',
      "components/x.tsx": 'export const X = () => import("@/lib/mid");',
      "app/(desk)/desk/page.tsx": 'import "@/components/x"; export default 1;',
    });
    expect([...derive(root, "lib/leaf.ts")!].sort()).toEqual(["booking", "calendar"]);
  });
  it("is null when nothing reaches the file", () => {
    expect(derive(fixture({ "lib/orphan.ts": "export const a = 1;" }), "lib/orphan.ts")).toBeNull();
  });
  it("is null when ANY reaching entry is unattributed", () => {
    const root = fixture({
      "lib/shared.ts": "export const a = 1;",
      "app/(desk)/desk/page.tsx": 'import "@/lib/shared";',
      "app/(app)/mystery/page.tsx": 'import "@/lib/shared";',
    });
    expect(derive(root, "lib/shared.ts")).toBeNull();
  });
  it("is null when an e2e helper, a script or a config file imports the file", () => {
    for (const outside of ["e2e/helpers/x.ts", "e2e-payment/helpers/x.ts", "scripts/x.mjs", "playwright.config.ts", "instrumentation-client.ts", "sentry.server.config.ts", "sentry.edge.config.ts"]) {
      const root = fixture({
        "lib/shared.ts": "export const a = 1;",
        "app/(desk)/desk/page.tsx": 'import "@/lib/shared";',
        [outside]: 'import "../../lib/shared";'.replace("../../", outside.split("/").length === 1 ? "./" : "../".repeat(outside.split("/").length - 1)),
      });
      expect(derive(root, "lib/shared.ts"), outside).toBeNull();
    }
  });
  it("the real root-level Sentry and instrumentation files make what they import unprovable (extended)", () => {
    const graph = buildImportGraph(process.cwd());
    for (const root of ["instrumentation-client.ts", "sentry.server.config.ts", "sentry.edge.config.ts"]) {
      const imported = [...graph.outsideImporters.entries()].filter(([, who]) => who.has(root)).map(([f]) => f);
      for (const f of imported) {
        if (!/^(app|components|lib|hooks)\//.test(f)) continue;
        expect(reachingEntries(graph, f).outside, `${f} (imported by ${root})`).toContain(root);
        expect(sel(f).extended || !/\(import graph\)/.test(sel(f).reason), f).toBe(true);
      }
    }
    expect([...graph.outsideImporters.keys()].some((f) => f.startsWith("lib/observability/"))).toBe(true);
  });
  it("an entry file is its own entry", () => {
    expect(isEntry("app/(app)/calendar/page.tsx")).toBe(true);
    expect(isEntry("middleware.ts")).toBe(true);
    expect(isEntry("components/ui/button.tsx")).toBe(false);
    expect(isEntry("app/(app)/calendar/CalendarToolbar.tsx")).toBe(false);
  });
});

// -- the route audit, proved from the specs' own URLs -----------------------------------------------------------------------------------
// The ONE payment-lane spec allowed to open an audited route outside BROWSER_GROUPS (see the known gap below). Any other e2e-payment spec that
// visits an audited route fails the audit, so a new one cannot slip past it.
const PAYMENT_LANE_EXEMPT = ["e2e-payment/split-money-three-screens.spec.ts"];

describe("VERIFIED_ROUTES: every spec that visits an audited route is in a group its path rule selects", () => {
  const specFiles = readdirSync(ROOT, { withFileTypes: true })
    // Payment-lane specs are selected separately (the `payment` path rule), not through BROWSER_GROUPS; only the one named spec is exempt.
    // KNOWN GAP: that spec (split-money-three-screens.spec.ts) also drives /financials/analytics, and a change
    // to an analytics file selects owner_admin and smoke, never the payment lane, so that spec does not run for it. It predates the route
    // audit, which only surfaced it. Follow-up: Machines (assigned by OPS).
    .filter((d) => d.isDirectory() && /^e2e(-[\w]+)?$/.test(d.name))
    .flatMap((d) => readdirSync(path.join(ROOT, d.name)).filter((f) => f.endsWith(".spec.ts")).filter((f) => !PAYMENT_LANE_EXEMPT.includes(`${d.name}/${f}`)).map((f) => ({ f, text: readFileSync(path.join(ROOT, d.name, f), "utf8") })));
  const groupsOfSpec = (spec: string) => Object.entries(BROWSER_GROUPS as Record<string, { specs: string[] }>).filter(([, d]) => d.specs.includes(spec)).map(([g]) => g);
  const audit = (urlRe: RegExp, allowed: string[]) => {
    const visitors = specFiles.filter((x) => urlRe.test(x.text));
    expect(visitors.length).toBeGreaterThan(0);
    for (const v of visitors) expect(groupsOfSpec(v.f).some((g) => allowed.includes(g)), `${v.f} visits ${urlRe} but sits in ${groupsOfSpec(v.f)}`).toBe(true);
  };
  it("/financials/analytics is visited only by owner_admin specs", () => audit(/\/financials\/analytics/, ["owner_admin"]));
  it("the exemption is exactly one spec, and it still visits an audited route (a stale exemption fails)", () => {
    expect(PAYMENT_LANE_EXEMPT).toEqual(["e2e-payment/split-money-three-screens.spec.ts"]);
    expect(readFileSync(path.join(ROOT, PAYMENT_LANE_EXEMPT[0]), "utf8")).toMatch(/\/financials\/analytics/);
  });
  it("/desk is visited only by calendar or booking specs", () => audit(/["'`]\/desk["'`/?]/, ["calendar", "booking"]));
});

// -- the independent proof against the real tree -----------------------------------------------------------------------------------------
describe("the derivation is proved against the real import graph (second, independent walk)", () => {
  const files = SOURCE_ROOTS.flatMap((d) => walk(path.join(ROOT, d)));
  const importers = new Map<string, Set<string>>();
  for (const f of files) {
    const src = readFileSync(path.join(ROOT, f), "utf8");
    for (const m of src.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
      const t = resolveImport(f, m[1]);
      if (t) (importers.get(t) ?? importers.set(t, new Set()).get(t)!).add(f);
    }
  }
  const entryRe = /(^|\/)(page|route|layout|template|error|global-error|loading|not-found|default|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.(ts|tsx)$/;
  const isEntryFile = (f: string) => f.startsWith("app/") && entryRe.test(f);
  const entriesOf = (target: string): string[] => {
    const seen = new Set([target]);
    const stack = [target];
    const out = new Set<string>(isEntryFile(target) ? [target] : []);
    while (stack.length) {
      for (const y of importers.get(stack.pop()!) ?? []) if (!seen.has(y)) { seen.add(y); stack.push(y); if (isEntryFile(y)) out.add(y); }
    }
    return [...out];
  };
  // an entry's own groups: what the path rules say when the entry changes on its own (never through the graph, so no circularity)
  const own = (e: string) => {
    const s = sel(e);
    return s.extended ? null : s.groups.filter((g) => g !== "smoke");
  };

  it("finds the application files (the walk is not vacuous)", () => {
    expect(files.length).toBeGreaterThan(1000);
    expect([...importers.keys()].length).toBeGreaterThan(500);
  });

  it("every file selected through the graph selects EXACTLY the union of its reaching entries' groups, never fewer", () => {
    let derivedCount = 0;
    for (const f of files) {
      const s = sel(f);
      if (s.extended || !/\(import graph\)/.test(s.reason)) continue;
      derivedCount++;
      const want = new Set<string>();
      for (const e of entriesOf(f)) for (const g of own(e) ?? ["__unattributed__"]) want.add(g);
      expect(want.has("__unattributed__"), `${f} reaches an unattributed entry`).toBe(false);
      expect(entriesOf(f).length, f).toBeGreaterThan(0);
      expect(s.groups.filter((g) => g !== "smoke").sort(), f).toEqual([...want].sort());
    }
    expect(derivedCount).toBeGreaterThan(10);
  });

  it("no file imported from e2e, scripts or config is ever selected through the graph", () => {
    const outside = [...walk(path.join(ROOT, "e2e")), ...readdirSync(ROOT).filter((n) => n.startsWith("e2e-")).flatMap((d) => walk(path.join(ROOT, d))), ...readdirSync(path.join(ROOT, "scripts")).filter((n) => /\.(ts|mjs)$/.test(n)).map((n) => `scripts/${n}`)];
    const imported = new Set<string>();
    for (const f of outside) {
      if (!existsSync(path.join(ROOT, f))) continue;
      for (const m of readFileSync(path.join(ROOT, f), "utf8").matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)) {
        const t = resolveImport(f, m[1]);
        if (t && SOURCE_ROOTS.some((r) => t.startsWith(`${r}/`))) imported.add(t);
      }
    }
    expect(imported.size).toBeGreaterThan(0);
    for (const f of imported) {
      const s = sel(f);
      if (s.extended) continue;
      // attributed by a path rule is the existing behaviour; it must not come from the graph
      expect(s.reason, f).not.toMatch(/\(import graph\)/);
    }
  });

  it("the scanned roots build every import from a string literal (a computed specifier would be invisible to the graph)", () => {
    const computed: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(path.join(ROOT, f), "utf8").matchAll(/\b(?:import|require)\(\s*([^"'\s)][^)]*)\)/g)) {
        if (!/^["'`]/.test(m[1].trim()) || /\$\{/.test(m[1])) computed.push(`${f}: ${m[0].slice(0, 80)}`);
      }
    }
    expect(computed).toEqual([]);
  });

  it("every spec group named by a derived mapping really exists and holds specs", () => {
    for (const g of ["owner_admin", "sessions", "calendar", "booking"]) expect((BROWSER_GROUPS as Record<string, { specs: string[] }>)[g].specs.length, g).toBeGreaterThan(0);
    expect(EXTENDED).toBe("__extended__");
  });

  it("the graph module and this proof agree on the entry set", () => {
    const graph = buildImportGraph(ROOT);
    for (const f of files.slice(0, 400)) expect(isEntry(f), f).toBe(isEntryFile(f) || f === "middleware.ts" || f === "instrumentation.ts");
    expect(reachingEntries(graph, "lib/business-analytics/chart-geometry.ts").entries.length).toBeGreaterThan(0);
  });
});
