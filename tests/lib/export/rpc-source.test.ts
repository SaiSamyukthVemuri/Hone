import { describe, expect, it } from "vitest";
import { fetchExportRpcRows, rowsForResource, selectedColumnsByResource } from "@/lib/export/provenance";
import {
  auditRpcSources,
  auditSelectedColumns,
  type ExportedDisposition,
  type RegistryEntry,
} from "@/lib/export/resource-registry";

// Synthetic fixtures only. The rpc source kind is how an export reads a table no browser role may SELECT (RLS on, no policy): through its
// owner-gated function, paged by keyset, with the returned columns checked against the declared ones.

const RETURNS = ["answer_id", "kind", "why_not_work", "answers_erased_at"] as const;
const SPEC = { keyColumn: "answer_id", returns: RETURNS } as const;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const row = (n: number, o: Record<string, unknown> = {}) => ({
  answer_id: id(n),
  kind: "decline",
  why_not_work: `synthetic answer ${n}`,
  answers_erased_at: null,
  ...o,
});

/** A fake function over a fixed table: honours the keyset and the limit, and records every call. */
function fakeFn(table: Array<Record<string, unknown>>) {
  const calls: Array<{ after: string | null; limit: number }> = [];
  const call = async (after: string | null, limit: number) => {
    calls.push({ after, limit });
    const rows = table.filter((r) => after === null || (r.answer_id as string) > after).slice(0, limit);
    return { data: rows, error: null };
  };
  return { call, calls };
}

describe("fetchExportRpcRows paging", () => {
  it("follows the keyset until a short page and returns every row once", async () => {
    const table = Array.from({ length: 7 }, (_, i) => row(i + 1));
    const f = fakeFn(table);
    const out = await fetchExportRpcRows("waitlist_decline_answers", SPEC, f.call, 3);
    expect(out.error).toBeNull();
    expect(out.data).toHaveLength(7);
    expect(f.calls.map((c) => c.after)).toEqual([null, id(3), id(6)]);
  });
  it("an exact multiple of the page size costs one extra empty page and loses nothing", async () => {
    const f = fakeFn(Array.from({ length: 6 }, (_, i) => row(i + 1)));
    const out = await fetchExportRpcRows("waitlist_decline_answers", SPEC, f.call, 3);
    expect(out.data).toHaveLength(6);
    expect(f.calls).toHaveLength(3);
  });
  it("an empty table is an empty, successful read", async () => {
    const out = await fetchExportRpcRows("waitlist_decline_answers", SPEC, fakeFn([]).call, 3);
    expect(out).toMatchObject({ data: [], error: null });
  });
  it("refuses rather than loops when the key does not advance", async () => {
    const stuck = async () => ({ data: [row(1), row(2), row(3)], error: null });
    const out = await fetchExportRpcRows("waitlist_decline_answers", SPEC, stuck, 3);
    expect(out.data).toBeNull();
    expect(out.error?.message).toMatch(/partial table/);
  });
  it("an unsorted page whose keys are all above the cursor fails the read", async () => {
    const unsorted = async () => ({ data: [row(5), row(3), row(9)], error: null });
    const out = await fetchExportRpcRows("waitlist_decline_answers", SPEC, unsorted, 3);
    expect(out.data).toBeNull();
    expect(out.error?.message).toMatch(/strictly increase/);
  });
  it("an unsorted SECOND page above its cursor fails too, and duplicates inside a page fail", async () => {
    let n = 0;
    const pages = [[row(1), row(2), row(3)], [row(7), row(5), row(9)]];
    const out = await fetchExportRpcRows("waitlist_decline_answers", SPEC, async () => ({ data: pages[n++], error: null }), 3);
    expect(out.error?.message).toMatch(/strictly increase/);
    const dup = await fetchExportRpcRows("waitlist_decline_answers", SPEC, async () => ({ data: [row(1), row(1)], error: null }), 3);
    expect(dup.error?.message).toMatch(/strictly increase/);
  });
  it("a failed page fails the whole read; it never returns the pages before it", async () => {
    let n = 0;
    const flaky = async () => (++n === 2 ? { data: null, error: { message: "boom" } } : { data: [row(n * 10), row(n * 10 + 1)], error: null });
    const out = await fetchExportRpcRows("waitlist_decline_answers", SPEC, flaky, 2);
    expect(out.data).toBeNull();
    expect(out.error?.message).toMatch(/waitlist_decline_answers/);
  });
  it("a thrown call is a failed read, not an exception", async () => {
    const out = await fetchExportRpcRows("waitlist_decline_answers", SPEC, async () => {
      throw new Error("network");
    });
    expect(out.data).toBeNull();
    expect(out.error).not.toBeNull();
  });
});

describe("fetchExportRpcRows column check", () => {
  it("a missing declared column fails the read", async () => {
    const { answers_erased_at: _omit, ...short } = row(1);
    const out = await fetchExportRpcRows("waitlist_decline_answers", SPEC, async () => ({ data: [short], error: null }));
    expect(out.error?.message).toMatch(/did not return declared column\(s\): answers_erased_at/);
  });
  it("an undeclared extra column fails the read", async () => {
    const out = await fetchExportRpcRows("waitlist_decline_answers", SPEC, async () => ({ data: [{ ...row(1), client_email: "x" }], error: null }));
    expect(out.error?.message).toMatch(/undeclared column\(s\): client_email/);
  });
});

describe("what a non-owner and an erased row look like", () => {
  it("a non-owner gets zero rows: an empty successful read, no data and no error", async () => {
    // the function re-derives the owner and returns no rows for anyone else
    const out = await fetchExportRpcRows("waitlist_decline_answers", SPEC, async () => ({ data: [], error: null }));
    expect(rowsForResource("waitlist_decline_answers", out)).toEqual([]);
  });
  it("an erased row reaches the caller with no text and the erased marker", async () => {
    const erased = row(1, { why_not_work: null, answers_erased_at: "2026-11-09T10:00:00Z" });
    const out = await fetchExportRpcRows("waitlist_decline_answers", SPEC, async () => ({ data: [erased], error: null }));
    expect(out.data?.[0]).toMatchObject({ why_not_work: null, answers_erased_at: "2026-11-09T10:00:00Z" });
    expect(JSON.stringify(out.data)).not.toMatch(/synthetic answer/);
  });
});

describe("provenance of an rpc read", () => {
  it("the observed select is the declared return list, so the registry audit can see it", async () => {
    const out = await fetchExportRpcRows("waitlist_decline_answers", SPEC, fakeFn([row(1)]).call);
    expect(selectedColumnsByResource([out])).toEqual({ waitlist_decline_answers: [...RETURNS] });
  });
});

const entry = (over: Partial<ExportedDisposition> = {}): RegistryEntry<ExportedDisposition> => ({
  resource: "synthetic_answers",
  disposition: {
    kind: "exported",
    file: "synthetic-answers.csv",
    csvHeaders: [...RETURNS],
    includedColumns: [...RETURNS],
    excludedColumns: [],
    rowScope: "synthetic",
    sourceCountCheck: { kind: "none", reason: "synthetic" },
    description: "synthetic",
    rpcSource: { fn: "export_synthetic", keyColumn: "answer_id", returns: [...RETURNS] },
    ...over,
  },
}) as RegistryEntry<ExportedDisposition>;

describe("auditRpcSources", () => {
  const live = { export_synthetic: [...RETURNS] };
  it("passes when headers, declared returns and the live function agree", () => {
    expect(auditRpcSources(live, [entry()])).toEqual({ ok: true, problems: [] });
  });
  it("catches a live function that grew a column nobody declared", () => {
    const a = auditRpcSources({ export_synthetic: [...RETURNS, "client_email"] }, [entry()]);
    expect(a.ok).toBe(false);
    expect(a.problems.join()).toMatch(/undeclared column client_email/);
  });
  it("catches a live function that lost a declared column", () => {
    const a = auditRpcSources({ export_synthetic: RETURNS.filter((c) => c !== "kind") }, [entry()]);
    expect(a.problems.join()).toMatch(/declared column kind is not returned/);
  });
  it("catches a CSV header the function does not return", () => {
    const a = auditRpcSources(live, [entry({ csvHeaders: [...RETURNS, "ghost"] })]);
    expect(a.problems.join()).toMatch(/header ghost is not returned/);
  });
  it("catches a returned column that neither reaches the CSV nor is declared notEmitted, and accepts it once declared", () => {
    const dropped = entry({ csvHeaders: RETURNS.filter((c) => c !== "kind") });
    expect(auditRpcSources(live, [dropped]).problems.join()).toMatch(/returns kind but it neither reaches/);
    const declared = entry({
      csvHeaders: RETURNS.filter((c) => c !== "kind"),
      rpcSource: { fn: "export_synthetic", keyColumn: "answer_id", returns: [...RETURNS], notEmitted: { kind: "synthetic reason" } },
    });
    expect(auditRpcSources(live, [declared]).ok).toBe(true);
  });
  it("refuses when no live columns were supplied for the function", () => {
    expect(auditRpcSources({}, [entry()]).problems.join()).toMatch(/no live return columns/);
  });
  it("a registry entry without an rpc source is not touched", () => {
    const plain = entry({ rpcSource: undefined });
    expect(auditRpcSources({}, [plain]).ok).toBe(true);
  });
  it("the selected-columns audit accepts the rpc read's observed select", async () => {
    const out = await fetchExportRpcRows("synthetic_answers", SPEC, fakeFn([row(1)]).call);
    expect(auditSelectedColumns(selectedColumnsByResource([out]), [entry()]).ok).toBe(true);
  });
  it("an included column renamed by the function counts as selected under its emitted headers, and is caught when one is missing", () => {
    const renamed = entry({
      includedColumns: ["followup_id", "erased_at"],
      emittedAs: { followup_id: { headers: ["answer_id", "followup_id"], note: "n" }, erased_at: { headers: ["answers_erased_at"], note: "n" } },
      csvHeaders: ["answer_id", "followup_id", "answers_erased_at"],
      rpcSource: { fn: "export_synthetic", keyColumn: "answer_id", returns: ["answer_id", "followup_id", "answers_erased_at"] },
    });
    expect(auditSelectedColumns({ synthetic_answers: ["answer_id", "followup_id", "answers_erased_at"] }, [renamed]).ok).toBe(true);
    expect(auditSelectedColumns({ synthetic_answers: ["answer_id", "followup_id"] }, [renamed]).notSelected).toEqual(["synthetic_answers.erased_at"]);
  });
});
