import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isValidProbeOptionKey, PROBE_OPTIONS } from "@/lib/probes";

// Records → Sterile Items probe classification (migration 0155, test points
// #1/#2/#3). A sterile item can be explicitly classified as a specific catalog
// probe (probe_key), which is what makes an inventory lot inventory-BACKED for
// charting. Classification is NEVER inferred from item_description free text.
//
// The Records actions require full auth/studio context, so the write path is
// pinned at the source level; the resolver's accept/reject behaviour is proven
// as a pure predicate here, and the durable persistence in the DB/RLS suite.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

const ACTIONS = read("app/(app)/records/actions.ts");
const FORMS = read("app/(app)/records/record-forms.tsx");
const PAGE = read("app/(app)/records/page.tsx");

describe("probe classification field (#1 explicit, #3 optional)", () => {
  it("both add + edit forms render a probe_key <select> from the catalog, defaulting to unclassified", () => {
    expect(FORMS).toMatch(/data-testid="sterile-probe-key"/);
    expect(FORMS).toMatch(/name="probe_key"/);
    // A clear non-probe / unclassified default (so most sterile items stay null).
    expect(FORMS).toMatch(/Not a probe/);
    expect(FORMS).toMatch(/PROBE_OPTIONS/);
    // Rendered on both the Add and the Edit sterile-item forms.
    expect(
      (FORMS.match(/<ProbeClassificationField/g) ?? []).length,
    ).toBeGreaterThanOrEqual(2);
  });
});

describe("server persistence (#1 store, #2 reject invalid, #3 null when unclassified)", () => {
  it("both actions resolve probe_key server-side and store the validated value", () => {
    // Add + Update both call the resolver and persist its value.
    expect((ACTIONS.match(/resolveProbeKeyField\(formData\)/g) ?? []).length).toBe(2);
    expect((ACTIONS.match(/probe_key: probeKey\.value/g) ?? []).length).toBe(2);
    // Both abort on an invalid selection instead of writing a bad key.
    expect((ACTIONS.match(/if \(!probeKey\.ok\) return probeKey;/g) ?? []).length).toBe(2);
    // The write is the VALIDATED value, never a raw formData read.
    expect(ACTIONS).not.toMatch(/probe_key: str\(formData\.get\("probe_key"\)/);
  });

  it("(#2) the invalid-key guard GATES the write — the reject precedes every DB write in each action", () => {
    // For each action, `if (!probeKey.ok) return` must appear before its
    // insert/update, so an invalid key can never reach the database.
    for (const marker of [
      "export async function addSterileItemRecordAction",
      "export async function updateSterileItemRecordAction",
    ]) {
      const start = ACTIONS.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const body = ACTIONS.slice(start, start + 2000);
      const guardAt = body.indexOf("if (!probeKey.ok) return probeKey;");
      const writeAt = body.search(/\.(insert|update)\(/);
      expect(guardAt).toBeGreaterThan(-1);
      expect(writeAt).toBeGreaterThan(-1);
      expect(guardAt).toBeLessThan(writeAt);
    }
  });

  it("the resolver: empty → null (#3), unknown key → error (#2), catalog key → value (#1)", () => {
    const helper = ACTIONS.slice(
      ACTIONS.indexOf("function resolveProbeKeyField"),
    );
    const body = helper.slice(0, helper.indexOf("\n}\n") + 2);
    // Empty stays unclassified (null), never an error.
    expect(body).toMatch(/if \(!raw\) return \{ ok: true, value: null \}/);
    // Unknown value is rejected — NOT silently coerced.
    expect(body).toMatch(/if \(!isValidProbeOptionKey\(raw\)\)/);
    expect(body).toMatch(/not recognized/);
    // A validated catalog key is stored verbatim.
    expect(body).toMatch(/return \{ ok: true, value: raw \}/);
  });

  it("classification is NEVER inferred from item_description free text (no probe ILIKE heuristic)", () => {
    // probe_key is only ever read from the explicit form field, never derived
    // from item text — so no ILIKE '%probe%' identity heuristic anywhere.
    expect(ACTIONS).not.toMatch(/ilike/i);
    // The dormant tables are never touched from Records.
    expect(ACTIONS).not.toMatch(/probe_lots/);
    expect(ACTIONS).not.toMatch(/probe_lot_id/);
  });
});

describe("the isValidProbeOptionKey predicate backs #1/#2 accept/reject", () => {
  it("accepts every catalog key and rejects unknown / empty / free text", () => {
    for (const o of PROBE_OPTIONS) {
      expect(isValidProbeOptionKey(o.key)).toBe(true);
    }
    expect(isValidProbeOptionKey("")).toBe(false);
    expect(isValidProbeOptionKey("probe")).toBe(false);
    expect(isValidProbeOptionKey("../../etc")).toBe(false);
    expect(isValidProbeOptionKey("sterex-gold-two-piece-f3-short-EVIL")).toBe(false);
  });
});

describe("copy-last carries the classification forward (#3 non-probe stays null)", () => {
  it("the Records copy-last object includes probe_key from the newest record", () => {
    expect(PAGE).toMatch(/probe_key: records\[0\]\.probe_key/);
  });
});
