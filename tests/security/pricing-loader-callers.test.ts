import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The billing loaders return a client's custom price (and the owner's pricing note). Each REFUSES a
// non-owner viewer itself, and every caller must hand it an owner context. This enumerates the callers:
// the set of files is pinned (a new caller fails here and must be reviewed), and every call must pass an
// owner-derived argument (`viewerIsOwner` / `isOwner` / `actorIsOwner` / `args.viewerIsOwner`), never a literal true.

const ROOT = join(__dirname, "..", "..");
const LOADERS = ["getAuthoritativeSessionPaymentAmount", "resolveAppointmentQuotedAmountCents", "getAppointmentPaymentStates"] as const;
const DEFINERS = new Set([
  "lib/billing/authoritative-session-payment.ts",
  "lib/billing/appointment-settlement.ts",
  "lib/billing/appointment-payment-state.ts",
]);
export const PINNED_CALLERS: Record<string, string[]> = {
  getAuthoritativeSessionPaymentAmount: [
    "app/(app)/clients/[id]/sessions/[sessionId]/page.tsx",
    "app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts",
    "lib/billing/quick-checkout.ts",
  ],
  resolveAppointmentQuotedAmountCents: ["lib/billing/quick-checkout.ts"],
  getAppointmentPaymentStates: ["app/(app)/calendar/[id]/page.tsx", "app/(app)/dashboard/page.tsx"],
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

export function callsOf(fn: string, file: string, text: string): string[] {
  const calls: string[] = [];
  const re = new RegExp(`(?<![\\w.])${fn}\\(`, "g");
  for (const m of text.matchAll(re)) {
    if (/\bfunction\s+$/.test(text.slice(Math.max(0, m.index! - 20), m.index!))) continue;
    let depth = 0;
    let end = m.index! + m[0].length - 1;
    for (; end < text.length; end++) {
      if (text[end] === "(") depth++;
      else if (text[end] === ")" && --depth === 0) break;
    }
    calls.push(text.slice(m.index!, end + 1));
  }
  void file;
  return calls;
}

export const OWNER_ARG = /\b(viewerIsOwner|isOwner|actorIsOwner)\b/;

const files = ["app", "lib", "components"]
  .flatMap((d) => walk(join(ROOT, d)))
  .map((f) => ({ file: f.slice(ROOT.length + 1), text: readFileSync(f, "utf8") }))
  .filter((f) => !DEFINERS.has(f.file));

describe("pricing loader callers", () => {
  for (const fn of LOADERS) {
    const sites = files.flatMap((f) => callsOf(fn, f.file, f.text).map((call) => ({ file: f.file, call })));

    it(`${fn}: the caller files are exactly the pinned set (not vacuous)`, () => {
      expect([...new Set(sites.map((s) => s.file))].sort()).toEqual([...PINNED_CALLERS[fn]].sort());
    });

    it(`${fn}: every call passes an owner-derived viewer, never a literal`, () => {
      const bad = sites.filter((s) => !OWNER_ARG.test(s.call) || /viewerIsOwner:\s*true\b|,\s*true\s*\)$/.test(s.call));
      expect(bad.map((b) => b.file)).toEqual([]);
    });
  }

  it("negative control: a call without an owner argument, or with a literal true, IS flagged", () => {
    const noArg = callsOf("getAuthoritativeSessionPaymentAmount", "x.ts", "await getAuthoritativeSessionPaymentAmount({ studioId, sessionId, studioTimezone });");
    expect(noArg.filter((c) => !OWNER_ARG.test(c))).toHaveLength(1);
    const lit = callsOf("resolveAppointmentQuotedAmountCents", "x.ts", "await resolveAppointmentQuotedAmountCents(a, b, c, true);");
    expect(lit.filter((c) => /,\s*true\s*\)$/.test(c))).toHaveLength(1);
  });
});
