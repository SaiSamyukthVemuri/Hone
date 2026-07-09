import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isUuid, validateProbeLotId } from "@/lib/sessions/probe-lot-validation";

// Charting Validation PR 3: a client-supplied probe_lot_id must be a well-formed
// UUID belonging to the caller's OWN studio. Free-text/manual probe_lot_number
// is a separate field and never becomes an inventory-verified lot.

const OK_UUID = "11111111-2222-3333-4444-555555555555";

// Minimal fake of the studio-scoped probe_lots lookup.
// `found` controls whether the (id, studio_id) row exists; `dbError` simulates a
// query error. Records the eq() filters so we can assert studio scoping.
function fakeSupabase(opts: { found: boolean; dbError?: boolean }) {
  const filters: Record<string, unknown> = {};
  const chain = {
    select: () => chain,
    eq: (col: string, val: unknown) => {
      filters[col] = val;
      return chain;
    },
    maybeSingle: async () =>
      opts.dbError
        ? { data: null, error: { message: "boom" } }
        : { data: opts.found ? { id: OK_UUID } : null, error: null },
  };
  return {
    __filters: filters,
    from: (_t: string) => chain,
  } as unknown as Parameters<typeof validateProbeLotId>[0] & {
    __filters: Record<string, unknown>;
  };
}

describe("isUuid", () => {
  it("accepts a well-formed UUID; rejects junk/empty", () => {
    expect(isUuid(OK_UUID)).toBe(true);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("")).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});

describe("validateProbeLotId", () => {
  it("empty/null -> ok null (manual/free-text lot is fine; no query)", async () => {
    const sb = fakeSupabase({ found: false });
    expect(await validateProbeLotId(sb, "studio-1", null)).toEqual({ ok: true, value: null });
    expect(await validateProbeLotId(sb, "studio-1", "  ")).toEqual({ ok: true, value: null });
  });
  it("malformed probe_lot_id is rejected (not a UUID)", async () => {
    const sb = fakeSupabase({ found: false });
    const r = await validateProbeLotId(sb, "studio-1", "abc-123");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid/i);
  });
  it("valid same-studio probe_lot_id is accepted (and scoped by studio_id)", async () => {
    const sb = fakeSupabase({ found: true });
    const r = await validateProbeLotId(sb, "studio-1", OK_UUID);
    expect(r).toEqual({ ok: true, value: OK_UUID });
    // the lookup was scoped to the caller's studio
    expect((sb as unknown as { __filters: Record<string, unknown> }).__filters).toMatchObject({
      id: OK_UUID,
      studio_id: "studio-1",
    });
  });
  it("cross-studio / missing probe_lot_id is rejected (no row for this studio)", async () => {
    const sb = fakeSupabase({ found: false });
    const r = await validateProbeLotId(sb, "studio-1", OK_UUID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/inventory/i);
  });
  it("a lookup error is a clean rejection (never a silent accept)", async () => {
    const sb = fakeSupabase({ found: false, dbError: true });
    const r = await validateProbeLotId(sb, "studio-1", OK_UUID);
    expect(r.ok).toBe(false);
  });
});

describe("write path + autofill (source pins)", () => {
  function read(rel: string): string {
    return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
  }
  const ACTIONS = read("app/(app)/clients/[id]/sessions/[sessionId]/actions.ts");
  const BLOCK = read("app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts");
  const QUERIES = read("lib/supabase/queries.ts");

  it("addElectrolysisEntryAction verifies probe_lot_id BEFORE insert + uses the checked value", () => {
    expect(ACTIONS).toMatch(/validateProbeLotId\(\s*supabase,\s*studio\.id,/);
    expect(ACTIONS).toMatch(/if \(!lotCheck\.ok\) throw new Error\(lotCheck\.error\)/);
    expect(ACTIONS).toMatch(/probe_lot_id: lotCheck\.value/);
    // the old raw insert is gone
    expect(ACTIONS).not.toMatch(/probe_lot_id: nullableString\(formData\.get\("probe_lot_id"\)\)/);
  });
  it("the live one-page flow keeps free-text lot manual (probe_lot_id null, self-attested confirm)", () => {
    expect(BLOCK).toMatch(/probe_lot_id: null/);
    expect(BLOCK).toMatch(/probe_lot_number:/);
    expect(BLOCK).toMatch(/probe_lot_confirmed:\s*\n?\s*Boolean\(input\.probeLotConfirmed\)/);
  });
  it("probe-lot autofill stays studio-scoped (unchanged)", () => {
    expect(QUERIES).toMatch(/from\("probe_lots"\)[\s\S]*?\.eq\("studio_id", studioId\)[\s\S]*?\.eq\("active", true\)/);
  });
});
