import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ===========================================================================
// #828 G-26 slice 1: these server files log through safeLog (record ids
// removed) and must not regain a raw console call, which would send ids to
// Vercel runtime logs again. Later slices add files to CONVERTED.
// ===========================================================================

const CONVERTED: readonly string[] = [
  "app/(app)/clients/[id]/portal-messages-actions.ts",
  "app/(app)/clients/[id]/actions.ts",
  "app/(app)/clients/[id]/intake/actions.ts",
  "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts",
  "app/(app)/clients/[id]/clinical-notes-actions.ts",
  "app/(app)/calendar/[id]/manual-fee-actions.ts",
  "app/(app)/clients/[id]/booking-actions.ts",
];

/** Source with line and block comments removed, so a comment that mentions
 *  console does not trip the guard, and a commented-out call is not counted. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Raw console calls in source, however written: console.error(...),
 *  console["warn"](...), a destructured or aliased console. */
function rawConsoleUses(src: string): string[] {
  const c = code(src);
  const hits: string[] = [];
  for (const re of [/\bconsole\s*\.\s*\w+/g, /\bconsole\s*\[/g, /=\s*console\b/g, /\(\s*console\s*\)/g]) {
    for (const m of c.matchAll(re)) hits.push(m[0]);
  }
  return hits;
}

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

describe("G-26 slice 1: converted files log only through safeLog", () => {
  for (const rel of CONVERTED) {
    it(`${rel} has no raw console call and imports safeLog`, () => {
      const src = read(rel);
      expect(rawConsoleUses(src), rel).toEqual([]);
      expect(src).toContain('import { safeLog } from "@/lib/logging/safe-log";');
      expect(code(src)).toMatch(/\bsafeLog\.(error|warn|info)\(/);
    });
  }
});

describe("the guard itself can fail (negative controls)", () => {
  const base = 'import { safeLog } from "@/lib/logging/safe-log";\nsafeLog.error("x");\n';
  it.each([
    ["a raw console.error", 'console.error("x", id);'],
    ["a raw console.warn with spacing", "console . warn(id);"],
    ["bracket access", 'console["log"](id);'],
    ["an alias", "const c = console; c.error(id);"],
    ["passing console along", "wrap(console);"],
  ])("reintroducing %s is caught", (_label, line) => {
    expect(rawConsoleUses(base + line).length).toBeGreaterThan(0);
  });

  it("a comment mentioning console is not a hit", () => {
    expect(rawConsoleUses(`${base}// console.error used to log ids here\n/* console.warn */\n`)).toEqual([]);
  });

  it("every converted file is caught when a raw call is appended to it", () => {
    for (const rel of CONVERTED) {
      expect(rawConsoleUses(`${read(rel)}\nconsole.error("regressed");\n`).length, rel).toBeGreaterThan(0);
    }
  });
});
