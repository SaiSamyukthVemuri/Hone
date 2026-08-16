import { describe, expect, it } from "vitest";

// CHLOE PRODUCT D — STRUCTURED STERILE-ITEM DISCARD LIFECYCLE (migration 0182).
//
// Chloe sees expired-probe warnings on the Dashboard for stock she has already
// physically thrown away. She recorded that in the notes, but notes are prose:
// they carry no lifecycle meaning, so Hone still counts the row as actionable
// current inventory and keeps warning her. Her worry is reasonable — the
// warning reads as "Hone thinks I might still be using expired probes".
//
// The product answer is an explicit, practitioner-authored fact:
//
//   date_discarded IS NULL      -> no structured discard recorded
//   date_discarded IS NOT NULL  -> the practitioner asserted the physical stock
//                                  was discarded on that calendar date
//
// This mirrors record_keeping_disinfectants, which has carried exactly this
// column since 0085 ("date_discarded -> when it was ACTUALLY discarded", 0096).
// The concept is not new to Hone; only the sterile-items table lacked it.
//
// TWO INVARIANTS PULL AGAINST EACH OTHER AND BOTH ARE LOAD-BEARING:
//
//   1. Discarded stock is not current stock. It must not warn, suggest,
//      autofill, or be offered as usable for NEW work.
//   2. Discarding stock TODAY must not rewrite what happened LAST MONTH. The
//      historical row, and every treatment that referenced it, must remain
//      readable and truthful.
//
// A fix that satisfied (1) by filtering discarded rows out of the foundational
// inventory query would silently violate (2). The BASELINE block below is the
// tripwire that catches exactly that.
//
// NOTHING HERE MAY DEPEND ON PARSING NOTES. A physical-stock/compliance fact is
// practitioner-authored or it does not exist.
//
// PROVENANCE: this file is the reviewed successor to the crash-preserved test
// in recovery commit d43f4de8. Its product contract was correct and is kept;
// the mechanics were reworked — the recovered version predated the real schema
// change, so it reached the new field through `as Partial<Row> & {...}` and
// `as unknown as { isDiscarded?: boolean }` casts, and asserted auto-fill via
// `JSON.stringify(...).toContain(...)`. Both are now unnecessary and were
// actively harmful: the casts would have kept compiling if the field were never
// added, and a stringify-substring assertion passes on an incidental match
// anywhere in the object. Everything is now structurally typed and asserted.

import {
  buildDashboardTodo,
  type BuildDashboardTodoInput,
} from "@/lib/dashboard/todo-model";
import {
  activeProbeLotOptionsForProbe,
  buildProbeLotOptions,
  isCurrentStock,
  probeLotOptionLabel,
  probeLotOptionsForProbe,
  resolveInventoryAutofill,
  type ProbeLotInventoryRow,
  type ProbeLotOption,
} from "@/lib/record-keeping/probe-lot-inventory";
import { resolveProbeLotAutofill } from "@/lib/record-keeping/probe-lot-autofill";
import {
  chartedLifecycleStatus,
  type ChartedLifecycleStatus,
  type ProbeLotSuggestions,
} from "@/lib/record-keeping/probe-lot-suggestion";
import {
  isSupplyDiscarded,
  summarizeSupplyExpiry,
} from "@/lib/record-keeping/expiry";

const TODAY = "2026-08-15";
const PROBE = "ballet_f2";

// ---------------------------------------------------------------------------
// Dashboard To-do — the surface Chloe actually complained about
// ---------------------------------------------------------------------------

// Built from the REAL input type. An `as unknown as` cast here would let a
// wrong fixture compile and prove nothing — every other domain is neutral so
// the only rows under test are supply-expiry ones.
const NO_METRICS: BuildDashboardTodoInput["metrics"] = {
  reviewedSessions: 0,
  incompleteRecords: 0,
  missingProbeLots: 0,
  aftercareNotMarked: 0,
  recordsMissingDetails: 0,
};

const NO_STUDIO: BuildDashboardTodoInput["studio"] = {
  isOwner: true,
  intakesAwaitingReviewCount: 0,
  activeServicesCount: 3,
  paymentStatus: {
    hasAccount: true,
    onboardingCompleted: true,
    payoutsEnabled: true,
  },
};

const NO_ATTENTION: BuildDashboardTodoInput["attention"] = {
  totalClients: 0,
  clients: [],
  scanCapped: false,
};

function supplyTodoIds(
  supplies: BuildDashboardTodoInput["supplies"],
): string[] {
  const todo = buildDashboardTodo({
    assistant: { items: [], hasItems: false, totalFound: 0 },
    attention: NO_ATTENTION,
    supplies,
    metrics: NO_METRICS,
    studio: NO_STUDIO,
    todayLocal: TODAY,
  });
  return todo.items
    .filter((i) => i.kind === "supply_expiry")
    .map((i) => i.id);
}

describe("ORACLE — notes are not a lifecycle fact, and never become one", () => {
  it("an expired probe still warns even though the NOTES say it was discarded", () => {
    // This is Chloe's exact situation and it is CORRECT behaviour: the loader
    // never reads notes, so prose cannot resolve the domain condition. It is
    // also exactly why she is worried. The fix is a structured column, NOT
    // teaching this code to read the sentence.
    const ids = supplyTodoIds([
      {
        id: "probe-1",
        item_description: "Ballet probe F2 — notes: Discarded 2026-07-10",
        manufacturer_name: "Ballet",
        expiry_date: "2026-06-01",
      },
    ]);
    expect(ids).toContain("supply_expiry:probe-1");
  });

  it("changing only the notes text changes nothing about the machine state", () => {
    const before = supplyTodoIds([
      {
        id: "probe-1",
        item_description: "Ballet probe F2",
        manufacturer_name: "Ballet",
        expiry_date: "2026-06-01",
      },
    ]);
    const after = supplyTodoIds([
      {
        id: "probe-1",
        item_description:
          "Ballet probe F2 — DISCARDED, threw away, used up, do not discard",
        manufacturer_name: "Ballet",
        expiry_date: "2026-06-01",
      },
    ]);
    // Identical. No keyword in any free-text field may move the lifecycle.
    expect(after).toEqual(before);
    expect(after).toContain("supply_expiry:probe-1");
  });
});

// ---------------------------------------------------------------------------
// The Records-page summary banner — a CURRENT warning over a HISTORICAL list
// ---------------------------------------------------------------------------

describe("summarizeSupplyExpiry — discarded stock raises no warning count", () => {
  it("counts an expired item, then stops counting it once it is discarded", () => {
    const expired = { expiry_date: "2026-06-01", date_discarded: null };
    expect(summarizeSupplyExpiry([expired], TODAY)).toEqual({
      expired: 1,
      expiring: 0,
    });
    expect(
      summarizeSupplyExpiry(
        [{ expiry_date: "2026-06-01", date_discarded: "2026-07-10" }],
        TODAY,
      ),
    ).toEqual({ expired: 0, expiring: 0 });
  });

  it("an UNEXPIRED but discarded item never contributes to 'expiring soon'", () => {
    expect(
      summarizeSupplyExpiry(
        [{ expiry_date: "2026-08-20", date_discarded: "2026-08-01" }],
        TODAY,
      ),
    ).toEqual({ expired: 0, expiring: 0 });
  });

  it("BACK-COMPAT: an item with no lifecycle field behaves exactly as before", () => {
    // Contract #11: clean existing records without date_discarded retain their
    // existing semantics. The column is optional on this input precisely so
    // every pre-0182 caller and fixture is unaffected.
    expect(summarizeSupplyExpiry([{ expiry_date: "2026-06-01" }], TODAY)).toEqual(
      { expired: 1, expiring: 0 },
    );
  });

  it("isSupplyDiscarded treats only a real date as a discard", () => {
    expect(isSupplyDiscarded(null)).toBe(false);
    expect(isSupplyDiscarded(undefined)).toBe(false);
    expect(isSupplyDiscarded("")).toBe(false);
    expect(isSupplyDiscarded("2026-07-10")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Inventory model
// ---------------------------------------------------------------------------

function row(
  over: Partial<ProbeLotInventoryRow> & { id: string; lotNumber: string },
): ProbeLotInventoryRow {
  return {
    probeKey: PROBE,
    itemDescription: "Ballet probe F2",
    manufacturerName: "Ballet",
    expiryDate: null,
    dateDiscarded: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// BASELINES. These must hold BEFORE and AFTER the change; they are the tripwire
// against "fixing" the Dashboard by erasing retrospective truth.
// ---------------------------------------------------------------------------

describe("BASELINE — historical inventory stays resolvable", () => {
  it("an EXPIRED lot is still returned and still selectable historically", () => {
    // getProbeLotInventory deliberately returns expired lots so a historical
    // value stays selectable. Pinning it here means a later over-broad discard
    // filter cannot quietly remove the same guarantee.
    const opts = buildProbeLotOptions(
      [row({ id: "old", lotNumber: "LOT-OLD", expiryDate: "2026-01-01" })],
      TODAY,
    );
    expect(opts).toHaveLength(1);
    expect(opts[0].isExpired).toBe(true);
    expect(probeLotOptionsForProbe(opts, PROBE)).toHaveLength(1);
  });

  it("expired lots are excluded from CURRENT stock but retained in the list", () => {
    const opts = buildProbeLotOptions(
      [
        row({ id: "old", lotNumber: "LOT-OLD", expiryDate: "2026-01-01" }),
        row({ id: "new", lotNumber: "LOT-NEW", expiryDate: "2027-01-01" }),
      ],
      TODAY,
    );
    expect(probeLotOptionsForProbe(opts, PROBE)).toHaveLength(2);
    expect(activeProbeLotOptionsForProbe(opts, PROBE).map((o) => o.id)).toEqual([
      "new",
    ]);
  });

  it("autofill picks the single current lot", () => {
    const opts = buildProbeLotOptions(
      [
        row({ id: "old", lotNumber: "LOT-OLD", expiryDate: "2026-01-01" }),
        row({ id: "new", lotNumber: "LOT-NEW", expiryDate: "2027-01-01" }),
      ],
      TODAY,
    );
    const auto = resolveInventoryAutofill(opts, PROBE, null);
    expect(auto.kind).toBe("only-active");
    expect(auto.kind === "only-active" && auto.option.id).toBe("new");
  });
});

// ---------------------------------------------------------------------------
// TARGET STATE — contracts 2, 3 and 4.
// ---------------------------------------------------------------------------

describe("TARGET — a structured discard removes stock from CURRENT use", () => {
  it("a discarded lot is not offered as current stock", () => {
    const opts = buildProbeLotOptions(
      [
        row({
          id: "binned",
          lotNumber: "LOT-BINNED",
          // Deliberately NOT expired: discarded-but-unexpired must also stop
          // being current, or a thrown-away box still looks usable. This is the
          // case an expiry-only rule cannot reach.
          expiryDate: "2027-01-01",
          dateDiscarded: "2026-07-10",
        }),
        row({ id: "good", lotNumber: "LOT-GOOD", expiryDate: "2027-01-01" }),
      ],
      TODAY,
    );
    expect(activeProbeLotOptionsForProbe(opts, PROBE).map((o) => o.id)).toEqual([
      "good",
    ]);
  });

  it("a discarded lot never autofills, even as the ONLY lot", () => {
    const opts = buildProbeLotOptions(
      [
        row({
          id: "binned",
          lotNumber: "LOT-BINNED",
          expiryDate: "2027-01-01",
          dateDiscarded: "2026-07-10",
        }),
      ],
      TODAY,
    );
    const auto = resolveInventoryAutofill(opts, PROBE, null);
    expect(auto.kind).toBe("choose");
  });

  it("a discarded lot never autofills even when it IS the last confirmed one", () => {
    // Rule 1 of the auto-fill precedence biases toward the practitioner's last
    // confirmed inventory selection. A discard must beat that bias: the box is
    // gone regardless of how recently it was used.
    const opts = buildProbeLotOptions(
      [
        row({
          id: "binned",
          lotNumber: "LOT-BINNED",
          expiryDate: "2027-01-01",
          dateDiscarded: "2026-07-10",
        }),
      ],
      TODAY,
    );
    expect(resolveInventoryAutofill(opts, PROBE, "binned").kind).toBe("choose");
  });

  it("a discarded lot is STILL present for historical rendering", () => {
    // The whole point of not filtering at the query layer.
    const opts = buildProbeLotOptions(
      [
        row({
          id: "binned",
          lotNumber: "LOT-BINNED",
          expiryDate: "2026-01-01",
          dateDiscarded: "2026-07-10",
        }),
      ],
      TODAY,
    );
    expect(opts).toHaveLength(1);
    expect(probeLotOptionsForProbe(opts, PROBE)).toHaveLength(1);
    expect(opts[0].isDiscarded).toBe(true);
    expect(opts[0].dateDiscarded).toBe("2026-07-10");
  });

  it("discard and expiry are INDEPENDENT flags, never collapsed", () => {
    const opts = buildProbeLotOptions(
      [
        row({
          id: "both",
          lotNumber: "LOT-BOTH",
          expiryDate: "2026-01-01",
          dateDiscarded: "2026-07-10",
        }),
      ],
      TODAY,
    );
    expect(opts[0].isExpired).toBe(true);
    expect(opts[0].isDiscarded).toBe(true);
    expect(isCurrentStock(opts[0])).toBe(false);
  });

  it("a FUTURE-dated discard still counts as discarded (presence is the assertion)", () => {
    // Deliberate asymmetry with expiry, which IS a date comparison. Stock does
    // not un-vanish when the calendar rolls over, so the date is never compared
    // against today.
    const opts = buildProbeLotOptions(
      [row({ id: "x", lotNumber: "LOT-X", dateDiscarded: "2099-01-01" })],
      TODAY,
    );
    expect(opts[0].isDiscarded).toBe(true);
    expect(activeProbeLotOptionsForProbe(opts, PROBE)).toHaveLength(0);
  });

  it("current stock sorts ahead of discarded stock", () => {
    const opts = buildProbeLotOptions(
      [
        row({
          id: "binned",
          lotNumber: "AAA-BINNED",
          expiryDate: "2099-01-01",
          dateDiscarded: "2026-07-10",
        }),
        row({ id: "good", lotNumber: "ZZZ-GOOD", expiryDate: "2027-01-01" }),
      ],
      TODAY,
    );
    // Discarded loses despite a later expiry AND an earlier lot number, so the
    // ordering is decided by lifecycle and not by the tie-breakers.
    expect(opts.map((o) => o.id)).toEqual(["good", "binned"]);
  });

  it("the option label reports the discard", () => {
    const opts = buildProbeLotOptions(
      [
        row({
          id: "binned",
          lotNumber: "LOT-BINNED",
          expiryDate: "2026-01-01",
          dateDiscarded: "2026-07-10",
        }),
      ],
      TODAY,
    );
    expect(probeLotOptionLabel(opts[0])).toContain("DISCARDED 2026-07-10");
  });

  it("BACK-COMPAT: a row with a null discard is untouched in every respect", () => {
    // Contract #11 at the model layer.
    const opts = buildProbeLotOptions(
      [row({ id: "plain", lotNumber: "LOT-PLAIN", expiryDate: "2027-01-01" })],
      TODAY,
    );
    expect(opts[0].isDiscarded).toBe(false);
    expect(opts[0].dateDiscarded).toBeNull();
    expect(isCurrentStock(opts[0])).toBe(true);
    expect(probeLotOptionLabel(opts[0])).toContain("expires 2027-01-01");
    expect(activeProbeLotOptionsForProbe(opts, PROBE)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The history fallback — the subtle bypass.
// ---------------------------------------------------------------------------

// `chartedId` is the inventory item the last-charted row actually pointed at
// (null = it was a manual/free-text lot, which has no lifecycle to check).
// `lifecycle` is the verdict the identity-complete authority read produced for
// that exact item; it defaults to "unknown" whenever an id IS present, which is
// the honest default for a caller that has not resolved it.
function suggestions(
  lot: string,
  chartedId: string | null = null,
  lifecycle: ChartedLifecycleStatus | null = chartedId ? "unknown" : null,
): ProbeLotSuggestions {
  return {
    byKey: {
      [PROBE]: {
        lot,
        confirmed: false,
        inventoryItemId: null,
        lastConfirmedInventoryItemId: null,
        lastCharted: lot,
        lastChartedInventoryItemId: chartedId,
        lastChartedLifecycle: lifecycle,
      },
    },
    byLabel: {},
  };
}

describe("TARGET — the free-text history fallback cannot re-suggest discarded stock", () => {
  it("a last-charted lot NUMBER matching a DISCARDED inventory row routes to the picker", () => {
    // Without this the discard gate has a hole: with no current inventory the
    // resolver falls back to the last lot number the practitioner charted, and
    // would hand Chloe back the exact lot she just binned — as unlinked free
    // text, which also bypasses the server's linked-path gate entirely.
    const inventory = buildProbeLotOptions(
      [
        row({
          id: "binned",
          lotNumber: "LOT-BINNED",
          expiryDate: "2099-01-01",
          dateDiscarded: "2026-07-10",
        }),
      ],
      TODAY,
    );
    expect(
      resolveProbeLotAutofill({
        probeKey: PROBE,
        inventory,
        suggestions: suggestions("LOT-BINNED"),
      }),
    ).toEqual({ kind: "choose" });
  });

  it("POSITIVE CONTROL: an unrelated historical lot number still auto-fills", () => {
    // Proves the guard above is specific and has not simply disabled the
    // history fallback.
    const inventory = buildProbeLotOptions(
      [
        row({
          id: "binned",
          lotNumber: "LOT-BINNED",
          expiryDate: "2099-01-01",
          dateDiscarded: "2026-07-10",
        }),
      ],
      TODAY,
    );
    expect(
      resolveProbeLotAutofill({
        probeKey: PROBE,
        inventory,
        suggestions: suggestions("LOT-SOMETHING-ELSE"),
      }),
    ).toEqual({ kind: "from-history", lotNumber: "LOT-SOMETHING-ELSE" });
  });

  it("a MANUAL charted row (null id, null lifecycle) still autofills — no invented lifecycle", () => {
    // Contract E. A prior free-text lot was never inventory, so there is no
    // item whose lifecycle could be checked. `null` lifecycle must NOT be
    // conflated with "unknown" — that would break the manual-history contract
    // for every studio with zero probe inventory.
    expect(
      resolveProbeLotAutofill({
        probeKey: PROBE,
        inventory: [],
        suggestions: suggestions("MANUAL-LOT", null, null),
      }),
    ).toEqual({ kind: "from-history", lotNumber: "MANUAL-LOT" });
  });

  it("a RECLASSIFIED discarded lot is still caught (guard checks by IDENTITY)", () => {
    // Regression, Codex review of 389c6c2c. The guard used to search only rows
    // whose CURRENT probe classification matched the selected probe, so this
    // sequence escaped it entirely:
    //   1. chart lot X for probe P, linked to inventory item I
    //   2. later edit I: reclassify it to probe Q AND mark it discarded
    //   3. chart a new block for probe P
    // `getProbeLotSuggestions` still truthfully reports X under the HISTORICAL
    // probe P, but I no longer appeared in the probe-P option list, so the
    // discarded lot auto-filled as unlinked free text — violating the contract
    // that discarded stock is never suggested. Reclassifying a box does not put
    // it back on the shelf.
    const inventory = buildProbeLotOptions(
      [
        row({
          id: "I",
          lotNumber: "LOT-X",
          probeKey: "some_other_probe", // reclassified away from PROBE
          expiryDate: "2099-01-01", // NOT expired: the discard alone must catch it
          dateDiscarded: "2026-07-10",
        }),
      ],
      TODAY,
    );
    // The probe-scoped guard genuinely cannot see it — that is the hole.
    expect(probeLotOptionsForProbe(inventory, PROBE)).toHaveLength(0);
    // The identity guard does, because the charted row pointed at item "I".
    expect(
      resolveProbeLotAutofill({
        probeKey: PROBE,
        inventory,
        suggestions: suggestions("LOT-X", "I"),
      }),
    ).toEqual({ kind: "choose" });
  });

  it("does NOT over-fire: another probe's same-numbered CURRENT lot stays silent", () => {
    // Lot numbers are explicitly not unique across inventory rows. The guard is
    // by IDENTITY precisely so a coincidence of numbers cannot block a
    // legitimate history suggestion — the existing contract "an expired lot for
    // ANOTHER probe never blocks this probe's history" must keep holding.
    const inventory = buildProbeLotOptions(
      [
        row({
          id: "other-current",
          lotNumber: "LOT-X",
          probeKey: "some_other_probe",
          expiryDate: "2099-01-01",
        }),
      ],
      TODAY,
    );
    expect(
      resolveProbeLotAutofill({
        probeKey: PROBE,
        inventory,
        suggestions: suggestions("LOT-X"),
      }),
    ).toEqual({ kind: "from-history", lotNumber: "LOT-X" });
  });

  it("a discarded lot does not count as inventory for the fallback decision", () => {
    // `active.length > 0` must be false when the only lot is discarded, or the
    // resolver would take the inventory branch and return `choose` for the
    // wrong reason, masking a genuinely useful history suggestion.
    const inventory = buildProbeLotOptions(
      [
        row({
          id: "binned",
          lotNumber: "LOT-BINNED",
          expiryDate: "2099-01-01",
          dateDiscarded: "2026-07-10",
        }),
      ],
      TODAY,
    );
    expect(activeProbeLotOptionsForProbe(inventory, PROBE)).toHaveLength(0);
    expect(
      resolveProbeLotAutofill({
        probeKey: PROBE,
        inventory,
        suggestions: suggestions("HISTORIC-LOT"),
      }),
    ).toEqual({ kind: "from-history", lotNumber: "HISTORIC-LOT" });
  });
});

// ---------------------------------------------------------------------------
// FINDING C — the guard must not depend on the picker's filtered projection.
//
// Codex review of 2a6755f1. The identity guard previously resolved the charted
// id by looking it up in `inventory`, the charting picker's list. That list is
// FILTERED and BOUNDED: getProbeLotInventory requires a non-null probe_key,
// buildProbeLotOptions drops blank lot numbers, and the query caps at 500 rows.
// A real, discarded, historically linked item can therefore be ABSENT from it —
// and absence was indistinguishable from "was never inventory", so the guard
// failed OPEN and auto-filled discarded stock as unlinked free text.
//
// Proven against head 2a6755f1 BEFORE this repair: both the unclassified case
// and the blank-lot case returned { kind: "from-history", lotNumber: "X" }.
//
// The fix resolves lifecycle through getInventoryLifecycleByIds — an
// identity-complete, studio-scoped, id-keyed read applying none of those
// filters — and the guard consumes that verdict instead of the list.
// ---------------------------------------------------------------------------

describe("FINDING C — lifecycle authority is independent of the picker list", () => {
  // EVERY case here passes an inventory list that does NOT contain item "I".
  // That is the point: the item is absent from the picker projection
  // throughout, so any behaviour observed is attributable solely to the
  // authority verdict.
  const ABSENT: ProbeLotOption[] = [];

  it("1. resolves and is DISCARDED -> never autofills", () => {
    expect(
      resolveProbeLotAutofill({
        probeKey: PROBE,
        inventory: ABSENT,
        suggestions: suggestions("LOT-X", "I", "not-current"),
      }),
    ).toEqual({ kind: "choose" });
  });

  it("2. resolves and is EXPIRED -> never autofills", () => {
    expect(
      chartedLifecycleStatus(
        { expiryDate: "2026-01-01", dateDiscarded: null },
        TODAY,
      ),
    ).toBe("not-current");
    expect(
      resolveProbeLotAutofill({
        probeKey: PROBE,
        inventory: ABSENT,
        suggestions: suggestions("LOT-X", "I", "not-current"),
      }),
    ).toEqual({ kind: "choose" });
  });

  it("3. resolves and is CURRENT -> autofills (the guard does not over-fire)", () => {
    // Without this the whole block would pass just as well if the guard simply
    // refused everything carrying an id.
    expect(
      resolveProbeLotAutofill({
        probeKey: PROBE,
        inventory: ABSENT,
        suggestions: suggestions("LOT-X", "I", "current"),
      }),
    ).toEqual({ kind: "from-history", lotNumber: "LOT-X" });
  });

  it("4. exact id NO LONGER RESOLVES -> unknown -> FAILS CLOSED", () => {
    // Gone from the authority read entirely (deleted, or a cross-studio id RLS
    // hides). "I cannot tell whether this stock still exists" is not permission
    // to auto-fill it for new work.
    expect(chartedLifecycleStatus(undefined, TODAY)).toBe("unknown");
    expect(chartedLifecycleStatus(null, TODAY)).toBe("unknown");
    expect(
      resolveProbeLotAutofill({
        probeKey: PROBE,
        inventory: ABSENT,
        suggestions: suggestions("LOT-X", "I", "unknown"),
      }),
    ).toEqual({ kind: "choose" });
  });

  it("5. lifecycle READ FAILED -> unknown -> FAILS CLOSED", () => {
    // getProbeLotSuggestions maps a failed authority read to "unknown" for every
    // id rather than to "current"; the guard then refuses. Same observable
    // contract as case 4, asserted separately because the cause differs.
    expect(
      resolveProbeLotAutofill({
        probeKey: PROBE,
        inventory: ABSENT,
        suggestions: suggestions("LOT-X", "I", "unknown"),
      }),
    ).toEqual({ kind: "choose" });
  });

  it("B. probe_key CLEARED + discarded — the Finding C reproduction", () => {
    // Charted under P, then the item was made unclassified AND discarded. It
    // vanishes from the picker (getProbeLotInventory filters probe_key IS NOT
    // NULL) but the authority read still sees it.
    expect(
      resolveProbeLotAutofill({
        probeKey: PROBE,
        inventory: ABSENT,
        suggestions: suggestions("LOT-X", "I", "not-current"),
      }),
    ).toEqual({ kind: "choose" });
  });

  it("C. item outside the picker bound — the list plays no part in the verdict", () => {
    // Whether the item fell outside the 500-row cap, had its lot blanked, or was
    // unclassified, the picker is equally silent about it. A picker FULL of
    // unrelated current stock changes nothing.
    const noisyInventory = buildProbeLotOptions(
      [
        row({
          id: "unrelated",
          lotNumber: "OTHER-LOT",
          // A DIFFERENT probe, so this probe still has no current stock and the
          // resolver genuinely reaches the history fallback under test.
          probeKey: "some_other_probe",
          expiryDate: "2099-01-01",
        }),
      ],
      TODAY,
    );
    expect(noisyInventory.find((o) => o.id === "I")).toBeUndefined();
    expect(
      resolveProbeLotAutofill({
        probeKey: PROBE,
        inventory: noisyInventory,
        suggestions: suggestions("LOT-X", "I", "not-current"),
      }),
    ).toEqual({ kind: "choose" });
  });

  it("D. same lot number on ANOTHER physical item is judged by ITS OWN identity", () => {
    // The contract "an expired lot for ANOTHER probe never blocks this probe's
    // history" survives: the verdict attaches to the charted item's id, not to
    // the lot string, so another item sharing the number is irrelevant.
    const otherProbeSameNumber = buildProbeLotOptions(
      [
        row({
          id: "other",
          lotNumber: "LOT-X",
          probeKey: "some_other_probe",
          expiryDate: "2000-01-01", // expired, and irrelevant
        }),
      ],
      TODAY,
    );
    expect(
      resolveProbeLotAutofill({
        probeKey: PROBE,
        inventory: otherProbeSameNumber,
        suggestions: suggestions("LOT-X", "I", "current"),
      }),
    ).toEqual({ kind: "from-history", lotNumber: "LOT-X" });
  });

  it("E. a MANUAL historical row invents no lifecycle", () => {
    // null id + null lifecycle. Distinct from "unknown": there is no item, so
    // there is nothing to be unsure about, and the manual-history contract for
    // studios with zero probe inventory must keep working.
    expect(
      resolveProbeLotAutofill({
        probeKey: PROBE,
        inventory: ABSENT,
        suggestions: suggestions("MANUAL-LOT", null, null),
      }),
    ).toEqual({ kind: "from-history", lotNumber: "MANUAL-LOT" });
  });

  it("chartedLifecycleStatus: a discard outranks any expiry date", () => {
    // Presence is the assertion; even a future-dated discard means gone.
    expect(
      chartedLifecycleStatus(
        { expiryDate: "2099-01-01", dateDiscarded: "2026-07-10" },
        TODAY,
      ),
    ).toBe("not-current");
    expect(
      chartedLifecycleStatus(
        { expiryDate: "2099-01-01", dateDiscarded: "2099-12-31" },
        TODAY,
      ),
    ).toBe("not-current");
    expect(
      chartedLifecycleStatus({ expiryDate: null, dateDiscarded: null }, TODAY),
    ).toBe("current");
  });
});
