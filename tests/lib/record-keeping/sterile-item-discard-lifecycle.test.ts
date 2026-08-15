import { beforeEach, describe, expect, it, vi } from "vitest";

// CHLOE PRODUCT D - STRUCTURED STERILE-ITEM DISCARD LIFECYCLE.
//
// Chloe sees expired-probe warnings on the Dashboard for stock she has already
// physically thrown away. She recorded that in the notes, but notes are prose:
// they carry no lifecycle meaning, so Hone still counts the row as actionable
// current inventory and keeps warning her. Her worry is reasonable - the
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
// A fix that satisfies (1) by filtering discarded rows out of the foundational
// inventory query would silently violate (2). That is what NC-D exists to catch.
//
// NOTHING HERE MAY DEPEND ON PARSING NOTES. A physical-stock/compliance fact is
// practitioner-authored or it does not exist.

import {
  buildDashboardTodo,
  type BuildDashboardTodoInput,
} from "@/lib/dashboard/todo-model";
import {
  buildProbeLotOptions,
  activeProbeLotOptionsForProbe,
  probeLotOptionsForProbe,
  resolveInventoryAutofill,
} from "@/lib/record-keeping/probe-lot-inventory";

const TODAY = "2026-08-15";
const STUDIO = "11111111-1111-4111-8111-111111111111";

// ---------------------------------------------------------------------------
// Dashboard To-do
// ---------------------------------------------------------------------------

// Built from the REAL input type. An `as unknown as` cast here would let a
// wrong fixture compile and prove nothing - every other domain is neutral so
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

describe("PHASE 2 ORACLE - notes are not a lifecycle fact", () => {
  it("an expired probe still warns even though the NOTES say it was discarded", () => {
    // This is Chloe's exact situation and it is CORRECT pre-fix behaviour:
    // the loader never reads notes, so prose cannot resolve the domain
    // condition. It is also exactly why she is worried. The fix is a
    // structured column, NOT teaching this code to read the sentence.
    const ids = supplyTodoIds([
      {
        id: "probe-1",
        item_description: "Ballet probe F2 - notes: Discarded 2026-07-10",
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
          "Ballet probe F2 - DISCARDED, threw away, used up, do not discard",
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
// Historical truth baselines. These must hold BEFORE and AFTER the change; they
// are the tripwire against "fixing" the Dashboard by erasing retrospective
// truth.
// ---------------------------------------------------------------------------

type Row = Parameters<typeof buildProbeLotOptions>[0][number];

function row(over: Partial<Row> & { id: string; lotNumber: string }): Row {
  return {
    probeKey: "ballet_f2",
    itemDescription: "Ballet probe F2",
    manufacturerName: "Ballet",
    expiryDate: null,
    ...over,
  } as Row;
}

describe("PHASE 2 BASELINE - historical inventory stays resolvable", () => {
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
    expect(probeLotOptionsForProbe(opts, "ballet_f2")).toHaveLength(1);
  });

  it("expired lots are excluded from CURRENT stock but retained in the list", () => {
    const opts = buildProbeLotOptions(
      [
        row({ id: "old", lotNumber: "LOT-OLD", expiryDate: "2026-01-01" }),
        row({ id: "new", lotNumber: "LOT-NEW", expiryDate: "2027-01-01" }),
      ],
      TODAY,
    );
    expect(probeLotOptionsForProbe(opts, "ballet_f2")).toHaveLength(2);
    const active = activeProbeLotOptionsForProbe(opts, "ballet_f2");
    expect(active.map((o) => o.id)).toEqual(["new"]);
  });

  it("autofill picks the single active lot", () => {
    const opts = buildProbeLotOptions(
      [
        row({ id: "old", lotNumber: "LOT-OLD", expiryDate: "2026-01-01" }),
        row({ id: "new", lotNumber: "LOT-NEW", expiryDate: "2027-01-01" }),
      ],
      TODAY,
    );
    const auto = resolveInventoryAutofill(opts, "ballet_f2", null);
    expect(JSON.stringify(auto)).toContain("new");
  });
});

// ---------------------------------------------------------------------------
// TARGET STATE. These fail before migration 0182 + the model change and are the
// reason this branch exists.
// ---------------------------------------------------------------------------

describe("TARGET - a structured discard removes stock from CURRENT use", () => {
  it("a discarded lot is not offered as current stock", () => {
    const opts = buildProbeLotOptions(
      [
        row({
          id: "binned",
          lotNumber: "LOT-BINNED",
          expiryDate: "2027-01-01",
          // Deliberately NOT expired: discarded-but-unexpired must also stop
          // being current, or a thrown-away box still looks usable.
          dateDiscarded: "2026-07-10",
        } as Partial<Row> & { id: string; lotNumber: string }),
        row({ id: "good", lotNumber: "LOT-GOOD", expiryDate: "2027-01-01" }),
      ],
      TODAY,
    );
    const active = activeProbeLotOptionsForProbe(opts, "ballet_f2");
    expect(active.map((o) => o.id)).toEqual(["good"]);
  });

  it("a discarded lot never autofills", () => {
    const opts = buildProbeLotOptions(
      [
        row({
          id: "binned",
          lotNumber: "LOT-BINNED",
          expiryDate: "2027-01-01",
          dateDiscarded: "2026-07-10",
        } as Partial<Row> & { id: string; lotNumber: string }),
      ],
      TODAY,
    );
    const auto = resolveInventoryAutofill(opts, "ballet_f2", null);
    expect(JSON.stringify(auto)).not.toContain("LOT-BINNED");
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
        } as Partial<Row> & { id: string; lotNumber: string }),
      ],
      TODAY,
    );
    expect(opts).toHaveLength(1);
    expect(probeLotOptionsForProbe(opts, "ballet_f2")).toHaveLength(1);
    expect(
      (opts[0] as unknown as { isDiscarded?: boolean }).isDiscarded,
    ).toBe(true);
  });
});
