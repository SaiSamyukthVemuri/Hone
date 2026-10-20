import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  compareChartedRecency,
  orderByRecency,
  pickNewestChartedSession,
  type ChartedBlockRow,
} from "@/lib/sessions/charted-session";
import {
  pickLastTreatment,
  pickPreClientWatchPlanSource,
} from "@/lib/sessions/clinical-summary";
import { buildTreatmentIntelligence } from "@/lib/sessions/treatment-intelligence";

// ===========================================================================
// F3 — ONE AUTHORITY FOR "THE LATEST CLINICAL HISTORY", AND ONE TIE RULE
// ===========================================================================
//
// THE DEFECT THIS PINS. Two selectors answered "which session is the client's
// most recent treatment?" and resolved it differently:
//
//   * pickNewestChartedSession (charting screen, /sessions/new, appointment
//     prep, dashboard prep strip) sorted by `started_at desc, id desc`;
//   * pickLastTreatment (Client Profile "Last treatment", dashboard
//     "Before today" lines) sorted by NOTHING — it walked the caller's array
//     and took the first charted row.
//
// Both callers of the second one order by `started_at desc` in SQL. That is not
// a total order: Postgres does not specify which of two rows sharing an exact
// `started_at` comes back first, and the two feeds have different query shapes
// (`.eq(client_id)` vs `.in(client_id, …) limit 400`), so they need not even
// agree with each other. The ambiguity reached the screen.
//
// The tie is reachable, not theoretical. The "Edit time" control writes a
// `datetime-local` value, so a corrected `started_at` carries `:00.000`
// seconds — two sessions corrected to the same minute are byte-identical.
//
// EVERY CONTROL BELOW IS PERMUTATION-BASED. A control that fed one fixed array
// order would pass just as happily against the broken selector, which is
// exactly the vacuity this file exists to avoid.

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

type Row = {
  id: string;
  started_at: string;
  record_status?: string | null;
  deleted_at?: string | null;
  created_at?: string;
  next_session_note?: string | null;
  electrolysis_entries: ReadonlyArray<{ deleted_at?: string | null }>;
  laser_entries: ReadonlyArray<{ deleted_at?: string | null }>;
};

function row(id: string, started_at: string, extra: Partial<Row> = {}): Row {
  return {
    id,
    started_at,
    record_status: "draft",
    deleted_at: null,
    electrolysis_entries: [],
    laser_entries: [],
    ...extra,
  };
}

const CHARTED = [{ deleted_at: null }];
// Typed as production's ChartedBlockRow so both selectors accept the map.
const blocks = (o: Record<string, ReadonlyArray<ChartedBlockRow>>) =>
  new Map(Object.entries(o));

/** Every ordering of `xs`. The selectors must not care which one they get. */
function permutations<T>(xs: readonly T[]): T[][] {
  if (xs.length <= 1) return [[...xs]];
  const out: T[][] = [];
  xs.forEach((x, i) => {
    const rest = [...xs.slice(0, i), ...xs.slice(i + 1)];
    for (const p of permutations(rest)) out.push([x, ...p]);
  });
  return out;
}

/** The set of answers a selector gives across EVERY input order. */
function answersAcrossOrders<T extends { id: string }>(
  rows: readonly T[],
  pick: (rows: readonly T[]) => T | null,
): Set<string | null> {
  return new Set(permutations(rows).map((p) => pick(p)?.id ?? null));
}

// ---------------------------------------------------------------------------
// CONTROL A — a newer clinical occurrence wins
// ---------------------------------------------------------------------------

describe("A — the newer clinical occurrence wins", () => {
  it("picks the session with the greater started_at, from any input order", () => {
    const rows = [
      row("s-old", "2026-01-10T10:00:00Z"),
      row("s-new", "2026-03-10T10:00:00Z"),
      row("s-mid", "2026-02-10T10:00:00Z"),
    ];
    const map = blocks({ "s-old": CHARTED, "s-new": CHARTED, "s-mid": CHARTED });

    expect(answersAcrossOrders(rows, (r) => pickLastTreatment(r, map))).toEqual(
      new Set(["s-new"]),
    );
    expect(
      answersAcrossOrders(rows, (r) => pickNewestChartedSession(r, map)),
    ).toEqual(new Set(["s-new"]));
  });

  it("an UNCHARTED newer session still cannot hide a charted older one", () => {
    // The original reason pickLastTreatment exists (PR #199): start_session
    // creates an empty row the instant a modality is tapped.
    const rows = [
      row("empty-newer", "2026-03-10T10:00:00Z"),
      row("charted-older", "2026-01-10T10:00:00Z"),
    ];
    const map = blocks({ "charted-older": CHARTED });
    expect(answersAcrossOrders(rows, (r) => pickLastTreatment(r, map))).toEqual(
      new Set(["charted-older"]),
    );
  });
});

// ---------------------------------------------------------------------------
// CONTROL B — creation time cannot steal "latest" from an older treatment
// ---------------------------------------------------------------------------

describe("B — a backfilled row's creation time cannot steal latest", () => {
  it("a row entered TODAY describing a 2019 treatment does not win", () => {
    const rows = [
      row("s-real", "2026-03-01T10:00:00Z", {
        created_at: "2026-03-01T10:05:00Z",
      }),
      // Entered months later; the treatment itself is seven years old.
      row("s-backfill", "2019-06-02T10:00:00Z", {
        created_at: "2026-08-20T09:00:00Z",
      }),
    ];
    const map = blocks({ "s-real": CHARTED, "s-backfill": CHARTED });

    expect(answersAcrossOrders(rows, (r) => pickLastTreatment(r, map))).toEqual(
      new Set(["s-real"]),
    );
    expect(
      answersAcrossOrders(rows, (r) => pickNewestChartedSession(r, map)),
    ).toEqual(new Set(["s-real"]));
  });

  it("no recency selector reads created_at at all", () => {
    // The structural guarantee behind the case above. `created_at` is row-insert
    // time; treating it as clinical recency is the single change that would
    // reintroduce the defect, so it is banned by inspection rather than left to
    // one fixture to notice.
    const summary = read("lib/sessions/clinical-summary.ts");
    const charted = read("lib/sessions/charted-session.ts");
    const pick = summary.slice(
      summary.indexOf("export function pickLastTreatment"),
      summary.indexOf("export type WatchPlanCandidate"),
    );
    expect(pick).not.toMatch(/created_at/);
    const cmp = charted.slice(
      charted.indexOf("export function compareChartedRecency"),
      charted.indexOf("export function orderByRecency"),
    );
    expect(cmp).not.toMatch(/created_at/);
    expect(cmp).toMatch(/started_at/);
  });
});

// ---------------------------------------------------------------------------
// CONTROL C — an exact tie is deterministic
// ---------------------------------------------------------------------------

describe("C — an exact started_at tie resolves deterministically", () => {
  const TIED = "2026-03-04T10:00:00.000Z";

  it("both selectors pick the same single winner across every input order", () => {
    const rows = [
      row("1111", TIED),
      row("9999", TIED),
      row("5555", TIED),
    ];
    const map = blocks({ "1111": CHARTED, "9999": CHARTED, "5555": CHARTED });

    const a = answersAcrossOrders(rows, (r) => pickLastTreatment(r, map));
    const b = answersAcrossOrders(rows, (r) => pickNewestChartedSession(r, map));
    // One answer, not merely a stable one: id descending, matching 0157.
    expect(a).toEqual(new Set(["9999"]));
    expect(b).toEqual(new Set(["9999"]));
  });

  it("the comparator is a strict total order (antisymmetric and transitive)", () => {
    // The property the retired comparator lacked: it returned -1 in BOTH
    // directions for equal keys, so Array#sort fell back to input order.
    const rows = [
      row("aaaa", "2026-03-04T10:00:00Z"),
      row("mmmm", "2026-03-04T10:00:00Z"),
      row("zzzz", "2026-01-04T10:00:00Z"),
      row("kkkk", "bad-timestamp"),
    ];

    // Reflexive.
    for (const x of rows) expect(compareChartedRecency(x, x) === 0).toBe(true);

    // Antisymmetric. Asserted as the property itself rather than through
    // Math.sign, which reports -0 for a zero result and would fail an
    // Object.is comparison against +0 for reasons that say nothing about order.
    for (const x of rows) {
      for (const y of rows) {
        const xy = compareChartedRecency(x, y);
        const yx = compareChartedRecency(y, x);
        if (xy === 0) expect(yx === 0).toBe(true);
        else expect(xy > 0).toBe(yx < 0);
      }
    }

    // Transitive: x <= y and y <= z implies x <= z, over every triple.
    for (const x of rows) {
      for (const y of rows) {
        for (const z of rows) {
          if (
            compareChartedRecency(x, y) <= 0 &&
            compareChartedRecency(y, z) <= 0
          ) {
            expect(compareChartedRecency(x, z) <= 0).toBe(true);
          }
        }
      }
    }
  });

  it("the tie-break matches the rule migration 0157 already uses in SQL", () => {
    const sql = read("supabase/migrations/0157_whole_session_copy_setup.sql");
    expect(sql).toMatch(/order by ps\.started_at desc, ps\.id desc/);
  });

  it("an unparseable started_at still yields one deterministic answer", () => {
    // Unreachable on this schema (`started_at timestamptz not null default
    // now()`), but the comparator must not silently decay to input order if a
    // malformed value ever arrives: NaN !== NaN would otherwise return NaN,
    // which Array#sort treats as 0.
    const rows = [
      row("aaaa", "not-a-timestamp"),
      row("zzzz", "also-not-a-timestamp"),
    ];
    const map = blocks({ "aaaa": CHARTED, "zzzz": CHARTED });
    expect(answersAcrossOrders(rows, (r) => pickLastTreatment(r, map)).size).toBe(
      1,
    );
  });

  it("a dated row outranks an undated one regardless of order", () => {
    const rows = [
      row("dated", "2020-01-01T10:00:00Z"),
      row("undated", "garbage"),
    ];
    expect(orderByRecency(rows)[0].id).toBe("dated");
    expect(orderByRecency([...rows].reverse())[0].id).toBe("dated");
  });
});

// ---------------------------------------------------------------------------
// CONTROL D — the two selectors choose the SAME winner
// ---------------------------------------------------------------------------

describe("D — SQL-rule and JS selectors agree on one winner", () => {
  const cases: Array<[string, Row[], Record<string, ReadonlyArray<ChartedBlockRow>>]> = [
    [
      "distinct occurrence times",
      [row("a", "2026-01-01T10:00:00Z"), row("b", "2026-05-01T10:00:00Z")],
      { a: CHARTED, b: CHARTED },
    ],
    [
      "exact tie",
      [row("1111", "2026-05-01T10:00:00Z"), row("9999", "2026-05-01T10:00:00Z")],
      { "1111": CHARTED, "9999": CHARTED },
    ],
    [
      "newer row is uncharted",
      [row("newer", "2026-05-01T10:00:00Z"), row("older", "2026-01-01T10:00:00Z")],
      { older: CHARTED },
    ],
    [
      "legacy laser row with entries but no blocks",
      [
        row("newer", "2026-05-01T10:00:00Z"),
        row("laser", "2026-01-01T10:00:00Z", { laser_entries: CHARTED }),
      ],
      {},
    ],
  ];

  it.each(cases)("%s — same winner from every input order", (_n, rows, bl) => {
    const map = blocks(bl);
    const a = answersAcrossOrders(rows, (r) => pickLastTreatment(r, map));
    const b = answersAcrossOrders(rows, (r) => pickNewestChartedSession(r, map));
    expect(a.size).toBe(1);
    expect(b.size).toBe(1);
    expect([...a][0]).toBe([...b][0]);
  });

  it("the watch/plan source resolves its ties the same way", () => {
    // It sits directly beneath the last-treatment card; the two reading from
    // differently-resolved ties is the contradiction to avoid.
    const TIED = "2026-04-01T09:00:00Z";
    const rows = [
      row("1111", TIED, { next_session_note: "plan one" }),
      row("9999", TIED, { next_session_note: "plan two" }),
    ];
    expect(
      answersAcrossOrders(rows, (r) =>
        pickPreClientWatchPlanSource(r, new Map()),
      ),
    ).toEqual(new Set(["9999"]));
  });
});

// ---------------------------------------------------------------------------
// CONTROL E — reversing a selector's rule turns these controls RED
// ---------------------------------------------------------------------------

describe("E — the controls are not vacuous", () => {
  it("the RETIRED trust-the-caller rule fails control C on the same fixture", () => {
    // Exactly what pickLastTreatment used to do: walk the caller's array.
    const retired = <T extends { id: string }>(
      rows: readonly T[],
      map: ReadonlyMap<string, ReadonlyArray<unknown>>,
    ) => rows.find((s) => (map.get(s.id)?.length ?? 0) > 0) ?? null;

    const TIED = "2026-03-04T10:00:00.000Z";
    const rows = [row("1111", TIED), row("9999", TIED)];
    const map = blocks({ "1111": CHARTED, "9999": CHARTED });

    // Two different answers depending only on input order — the defect.
    expect(answersAcrossOrders(rows, (r) => retired(r, map)).size).toBe(2);
    // The shipped selector gives one.
    expect(answersAcrossOrders(rows, (r) => pickLastTreatment(r, map)).size).toBe(
      1,
    );
  });

  it("the RETIRED area comparator reverses on equal dates; the shipped one does not", () => {
    // `(x.lastTreated < y.lastTreated ? 1 : -1)` returns -1 in both directions
    // for equal keys, so Array#sort's output depends on input order and length.
    const retired = (x: { lastTreated: string }, y: { lastTreated: string }) =>
      x.lastTreated < y.lastTreated ? 1 : -1;
    const same = ["A", "B", "C"].map((name) => ({ name, lastTreated: "2026-03-04" }));
    const forward = [...same].sort(retired).map((a) => a.name);
    const backward = [...same].reverse().sort(retired).map((a) => a.name);
    expect(forward).not.toEqual(backward);
  });

  it.each([
    ["Chin", "Upper lip", "Sideburns"],
    ["é", "e\u0301"],
  ])("`Latest setup` is stable across block orders for %j", (...areaNames) => {
    // areas[0] becomes the dashboard's "Latest setup" line. One session
    // treating two areas gives both the SAME lastTreated — the common case.
    const sessions = [
      {
        id: "s1",
        started_at: "2026-03-04T10:00:00Z",
        electrolysis_entries: [],
        laser_entries: [],
      },
    ];
    const block = (area: string) => ({
      session_id: "s1",
      primary_area: area,
      block_name: null,
      mode: "thermo",
      apilus_modality: null,
      energy_level: 14,
      machine_frequency: "27.12 MHz",
      probe_label: "Ballet F3",
      minutes_performed: 10,
      tolerance_rating: 3,
      reaction_type: null,
      caution_for_next_session: false,
      caution_note: null,
      entry_hairs: [] as ReadonlyArray<number | null>,
    });
    const rows = areaNames.map(block);

    const names = new Set(
      permutations(rows).map(
        (p) =>
          buildTreatmentIntelligence({
            sessionsNewestFirst: sessions,
            blocks: p,
          }).areas[0]?.name ?? null,
      ),
    );
    expect(names.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// CONTROL F — #648's fail-closed semantics are untouched
// ---------------------------------------------------------------------------

describe("F — CLIN-BEFORE-TODAY-F2 fail-closed behaviour is unchanged", () => {
  const PREVIEWS = read("lib/dashboard/before-today-previews.ts");

  it("this change touches no read outcome: the F2 wrapper is intact", () => {
    // A recency rule decides WHICH of the rows a successful read returned is
    // newest. It has no opinion about whether the read returned, and must not
    // acquire one.
    expect(PREVIEWS).toMatch(/type ReadOutcome = \{ rows: unknown\[\]; failed: boolean \}/);
    expect(PREVIEWS).toMatch(/const NOT_ISSUED: ReadOutcome/);
    expect(PREVIEWS).toMatch(/async function readRows\(/);
    expect(PREVIEWS).toMatch(/return \{ rows: \[\], failed: true \}/);
  });

  it("clinicalUnavailable and clientRecordUnavailable keep their definitions", () => {
    expect(PREVIEWS).toMatch(
      /const clinicalUnavailable =\s*\n?\s*sessionsRead\.failed \|\| blocksRead\.failed \|\| areasFailed;/,
    );
    // Deliberately separate: a clinical failure must not suppress true record
    // reminders, and a failed clients read must not blank a history that WAS read.
    expect(PREVIEWS).toMatch(
      /const clientRecordUnavailable = clientsRead\.failed;/,
    );
  });

  it("`unavailable` is still decided BEFORE `hasHistory`", () => {
    const compact = PREVIEWS.slice(
      PREVIEWS.indexOf("export function compactBeforeToday"),
      PREVIEWS.indexOf("type SessionRow"),
    );
    expect(compact.indexOf("if (briefing.unavailable)")).toBeGreaterThan(-1);
    expect(compact.indexOf("if (briefing.unavailable)")).toBeLessThan(
      compact.indexOf("if (!briefing.hasHistory)"),
    );
  });

  it("a failed read is still not an empty history: selection never sees those rows", () => {
    // `readRows` yields `rows: []` on failure, and an empty candidate set
    // yields null — a NON-answer the caller reports as unavailable. The
    // recency rule cannot turn that into a clinical absence.
    expect(pickLastTreatment([], new Map())).toBeNull();
    expect(pickNewestChartedSession([], new Map())).toBeNull();
  });
});

describe("H — sub-millisecond precision is honoured (Codex 4307093242)", () => {
  // Postgres timestamptz keeps microseconds; `Date` keeps milliseconds. Two
  // sessions 1µs apart must still resolve to the NEWER one, as SQL's
  // `order by started_at desc` does, not to whichever id sorts higher.
  const rows = [
    row("z-older", "2026-03-10T10:00:00.123456+00:00"),
    row("a-newer", "2026-03-10T10:00:00.123457+00:00"),
  ];
  const map = blocks({ "z-older": CHARTED, "a-newer": CHARTED });

  it("both selectors pick the microsecond-newer session, from any input order", () => {
    expect(answersAcrossOrders(rows, (r) => pickLastTreatment(r, map))).toEqual(
      new Set(["a-newer"]),
    );
    expect(
      answersAcrossOrders(rows, (r) => pickNewestChartedSession(r, map)),
    ).toEqual(new Set(["a-newer"]));
  });

  it("control: compared at millisecond precision they tie, and the id would pick the older", () => {
    expect(Date.parse(rows[0].started_at)).toBe(Date.parse(rows[1].started_at));
    expect(rows[0].id > rows[1].id).toBe(true);
  });

  it("offsets, missing fractions and short fractions compare exactly", () => {
    const cmp = (x: string, y: string) =>
      Math.sign(compareChartedRecency({ id: "a", started_at: x }, { id: "a", started_at: y }));
    // Same instant, different offsets: equal.
    expect(cmp("2026-03-10T10:00:00.5+00:00", "2026-03-10T05:00:00.500000-05:00")).toBe(0);
    // No fraction vs .000001: the latter is newer, so it sorts first.
    expect(cmp("2026-03-10T10:00:00Z", "2026-03-10T10:00:00.000001Z")).toBe(1);
    // Millisecond difference still decides before the sub-millisecond part.
    expect(cmp("2026-03-10T10:00:00.002000Z", "2026-03-10T10:00:00.001999Z")).toBe(-1);
  });
});

