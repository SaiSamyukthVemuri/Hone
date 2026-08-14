import { describe, expect, it } from "vitest";
import {
  getScopedUpcomingTimedBlocksSafe,
  getScopedRecurringBreakRulesSafe,
  getPractitionerDirectory,
  scopeLabel,
  type ScopeLoad,
} from "@/lib/booking/scoped-unavailability";

// PR B Part 3E-5 — the migration-order-safe SCOPED loaders. Legacy queries
// practitioner_id IS NULL; studio-default loads everything; a practitioner
// scope loads studio-wide + that practitioner; fall back to the legacy unscoped
// query ONLY on the undefined-column error; FAIL CLOSED on anything else.

type Res = { data: unknown; error: { code: string } | null };
const P1 = "11111111-1111-4111-8111-111111111111";

// Records every filter call so a test can assert HOW the scope was applied,
// and returns queued {data,error} on each terminal await so we can drive the
// scoped-then-legacy fallback path.
function mockQueue(results: Res[]) {
  let i = 0;
  const filters: Array<{ m: string; args: unknown[] }> = [];
  const next = (): Res => results[i++] ?? { data: null, error: null };
  function builder() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    for (const m of ["select", "eq", "is", "or", "gt", "gte", "lte", "order"]) {
      b[m] = (...args: unknown[]) => {
        filters.push({ m, args });
        return b;
      };
    }
    b.then = (onF: (v: Res) => unknown, onR?: (e: unknown) => unknown) =>
      Promise.resolve(next()).then(onF, onR);
    return b;
  }
  return {
    calls: () => i,
    filters,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mock: { from: () => builder() } as any,
    used: (m: string) => filters.some((f) => f.m === m),
    orArg: () => filters.find((f) => f.m === "or")?.args[0],
  };
}

const NOW = "2031-01-01T00:00:00Z";

describe("getScopedUpcomingTimedBlocksSafe — scope construction", () => {
  it("legacy: filters practitioner_id IS NULL (studio-wide only)", async () => {
    const q = mockQueue([{ data: [{ id: "b1" }], error: null }]);
    const rows = await getScopedUpcomingTimedBlocksSafe(q.mock, "s1", NOW, {
      mode: "legacy",
    });
    expect(rows).toEqual([{ id: "b1" }]);
    expect(q.used("is")).toBe(true); // .is("practitioner_id", null)
    expect(q.used("or")).toBe(false);
    expect(q.calls()).toBe(1);
  });

  it("studio-default: NO practitioner filter (all studio-wide + all scoped)", async () => {
    const q = mockQueue([{ data: [{ id: "b1" }, { id: "b2" }], error: null }]);
    await getScopedUpcomingTimedBlocksSafe(q.mock, "s1", NOW, {
      mode: "studio-default",
    });
    expect(q.used("is")).toBe(false);
    expect(q.used("or")).toBe(false);
  });

  it("practitioner: filters studio-wide OR that practitioner only", async () => {
    const q = mockQueue([{ data: [], error: null }]);
    await getScopedUpcomingTimedBlocksSafe(q.mock, "s1", NOW, {
      mode: "practitioner",
      practitionerId: P1,
    });
    expect(q.orArg()).toBe(`practitioner_id.is.null,practitioner_id.eq.${P1}`);
  });

  it("rejects a non-UUID practitioner id before building a filter (injection guard)", async () => {
    const q = mockQueue([{ data: [], error: null }]);
    await expect(
      getScopedUpcomingTimedBlocksSafe(q.mock, "s1", NOW, {
        mode: "practitioner",
        practitionerId: "not-a-uuid,practitioner_id.gt.0",
      } as ScopeLoad),
    ).rejects.toThrow(/scoped_unavailability_read_failed:scope_filter/);
  });

  it("falls back to the legacy unscoped query ONLY on undefined-column", async () => {
    const q = mockQueue([
      { data: null, error: { code: "42703" } }, // column absent (pre-0137)
      { data: [{ id: "legacy" }], error: null },
    ]);
    const rows = await getScopedUpcomingTimedBlocksSafe(q.mock, "s1", NOW, {
      mode: "legacy",
    });
    expect(rows).toEqual([{ id: "legacy" }]);
    expect(q.calls()).toBe(2);
  });

  it("FAILS CLOSED on any other error — no fallback, no data leak", async () => {
    const q = mockQueue([{ data: null, error: { code: "42501" } }]);
    await expect(
      getScopedUpcomingTimedBlocksSafe(q.mock, "s1", NOW, { mode: "legacy" }),
    ).rejects.toThrow(/scoped_unavailability_read_failed:timed_blocks:42501/);
    expect(q.calls()).toBe(1);
  });
});

describe("getScopedRecurringBreakRulesSafe — scope construction", () => {
  it("legacy filters NULL; practitioner uses the OR filter; studio-default neither", async () => {
    const legacy = mockQueue([{ data: [], error: null }]);
    await getScopedRecurringBreakRulesSafe(legacy.mock, "s1", { mode: "legacy" });
    expect(legacy.used("is")).toBe(true);

    const scoped = mockQueue([{ data: [], error: null }]);
    await getScopedRecurringBreakRulesSafe(scoped.mock, "s1", {
      mode: "practitioner",
      practitionerId: P1,
    });
    expect(scoped.orArg()).toBe(`practitioner_id.is.null,practitioner_id.eq.${P1}`);

    const all = mockQueue([{ data: [], error: null }]);
    await getScopedRecurringBreakRulesSafe(all.mock, "s1", { mode: "studio-default" });
    expect(all.used("is")).toBe(false);
    expect(all.used("or")).toBe(false);
  });

  it("fails over on PGRST204, fails closed on a connection error", async () => {
    const ok = mockQueue([
      { data: null, error: { code: "PGRST204" } },
      { data: [{ id: "r" }], error: null },
    ]);
    expect(await getScopedRecurringBreakRulesSafe(ok.mock, "s1", { mode: "legacy" })).toEqual([
      { id: "r" },
    ]);
    const bad = mockQueue([{ data: null, error: { code: "08006" } }]);
    await expect(
      getScopedRecurringBreakRulesSafe(bad.mock, "s1", { mode: "legacy" }),
    ).rejects.toThrow(/scoped_unavailability_read_failed:recurring_rules/);
  });
});

describe("getPractitionerDirectory + scopeLabel", () => {
  function dirMock(rows: unknown) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {};
    for (const m of ["select", "eq", "order"]) b[m] = () => b;
    b.then = (onF: (v: Res) => unknown) =>
      Promise.resolve({ data: rows, error: null } as Res).then(onF);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { from: () => b } as any;
  }

  it("splits selectable (active) from the full directory (active + inactive)", async () => {
    const dir = await getPractitionerDirectory(
      dirMock([
        { id: P1, display_name: "Ana", color: "#111", role: "owner", active: true },
        { id: "p2", display_name: "Bo", color: "#222", role: "practitioner", active: false },
      ]),
      "s1",
    );
    expect(dir.practitionerDirectory).toHaveLength(2);
    expect(dir.selectablePractitioners.map((p) => p.id)).toEqual([P1]); // Bo excluded
    expect(dir.byId.get("p2")?.active).toBe(false);
  });

  it("scopeLabel: studio-wide, active, inactive, and deleted practitioner", async () => {
    const dir = await getPractitionerDirectory(
      dirMock([
        { id: P1, display_name: "Ana", color: "#111", role: "owner", active: true },
        { id: "p2", display_name: "Bo", color: "#222", role: "practitioner", active: false },
      ]),
      "s1",
    );
    expect(scopeLabel(null, dir)).toBe("All practitioners");
    expect(scopeLabel(P1, dir)).toBe("Only Ana");
    expect(scopeLabel("p2", dir)).toBe("Only Bo, inactive");
    expect(scopeLabel("gone", dir)).toBe("A former practitioner");
  });
});
