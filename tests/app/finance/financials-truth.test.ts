import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

import {
  CAPACITY_NOT_YET,
  CASH_MOVEMENT_IS_NOT_EARNINGS,
  COLLECTED_ON_DELIVERED_IS_ONE_POPULATION,
  HISTORY_BEFORE_OUTCOMES,
  UNATTRIBUTED_IS_ALL_TIME,
  PERMANENT_LINES,
  UNKNOWN_EXPLANATION,
  UNKNOWN_LABEL,
} from "@/lib/finance/financial-copy";
import { summarizeCalendar } from "@/lib/finance/financial-briefing-model";
import type { FinancialUnknownCause } from "@/lib/finance/financial-fact";

// ===========================================================================
// FIN-01A SLICE 1 — the source guard
// ===========================================================================
//
// Load-bearing negative controls. Each one names the wrong behaviour it
// forbids, so a future author cannot satisfy it by deleting the assertion.
//
// Comments are stripped before matching: several of these files DISCUSS the
// tables and the coercions they must never perform, and the discussion is the
// documentation. Only executable source is searched.

const ROOT = path.resolve(__dirname, "../../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

const FILES = {
  fact: "lib/finance/financial-fact.ts",
  copy: "lib/finance/financial-copy.ts",
  model: "lib/finance/financial-briefing-model.ts",
  loader: "lib/finance/financial-briefing.ts",
  page: "app/(app)/financials/page.tsx",
  spine: "app/(app)/financials/financial-spine.tsx",
} as const;

const SOURCE = Object.fromEntries(
  Object.entries(FILES).map(([k, rel]) => [k, read(rel)]),
) as Record<keyof typeof FILES, string>;
const CODE = Object.fromEntries(
  Object.entries(SOURCE).map(([k, src]) => [k, codeOnly(src)]),
) as Record<keyof typeof FILES, string>;
const ALL_CODE = Object.values(CODE).join("\n");

const ALL_CAUSES: FinancialUnknownCause[] = [
  "not_recorded",
  "unavailable",
  "unknowable",
  "not_yet_supported",
  "not_enumerable",
  "records_incomplete",
];

// ---------------------------------------------------------------------------
// 1. Money entered in Slice 2 — from the right authorities, and only those
// ---------------------------------------------------------------------------
//
// SLICE 1 FORBADE MONEY OUTRIGHT. That assertion is gone because it is no
// longer the contract: Slice 2 reads money deliberately. What replaces it is
// strictly narrower and strictly harder — WHICH authority, under WHICH filters,
// and never a decoy.

describe("NC1 — the dormant and legacy money tables are never read", () => {
  // These are not "not yet". They are schema that exists, receives no runtime
  // write, and would report payments that never moved. `manual_fee_charge_attempts`
  // is pinned test-mode by a CHECK constraint, so it is structurally never real
  // money. Reading any of them is a defect in every slice, forever.
  const DECOYS = [
    "appointment_payments",
    "stripe_charge_attempts",
    "stripe_refunds",
    "stripe_refund_attempts",
    "manual_fee_charge_attempts",
    "payment_recovery_tokens",
  ];

  it.each(DECOYS)("no executable reference to %s", (identifier) => {
    expect(ALL_CODE).not.toContain(identifier);
  });
});

describe("NC2 — every read names its authority, and every ledger read is filtered", () => {
  const tablesRead = () =>
    [...CODE.loader.matchAll(/\.from\((["'])([^"']+)\1\)/g)].map((m) => m[2]);

  it("reads exactly the four authorities this slice is entitled to", () => {
    expect(new Set(tablesRead())).toEqual(
      new Set([
        "appointments",
        "services",
        "payment_charge_attempts",
        "appointment_settlements",
      ]),
    );
    // Nothing outside the loader reads anything at all.
    for (const key of ["fact", "copy", "model", "page", "spine"] as const) {
      expect(CODE[key], key).not.toContain(".from(");
    }
  });

  it("ONE appointments read feeds both censuses", () => {
    // Two reads of the same table over different windows would let the calendar
    // and the money panel disagree about which appointments exist.
    expect(tablesRead().filter((t) => t === "appointments")).toHaveLength(1);
  });

  it("EVERY payment_charge_attempts read is mode-scoped AND status-scoped", () => {
    // Migration 0105 permits one TEST and one LIVE succeeded attempt for the
    // same session, so an unfiltered sum double-counts one real payment.
    // FAILED rows also carry a populated `amount_cents`, so the status filter
    // is not redundant with the mode filter. Both are required on all four
    // windows this slice opens over the ledger.
    const reads = CODE.loader.split('.from("payment_charge_attempts")').slice(1);
    expect(reads.length).toBeGreaterThanOrEqual(3);
    for (const read of reads) {
      const head = read.slice(0, 600);
      expect(head, read.slice(0, 120)).toContain('.eq("stripe_livemode", livemode)');
      expect(head, read.slice(0, 120)).toContain('.eq("status", "succeeded")');
    }
    // The shared builder covers the remaining window; it carries both filters.
    expect(CODE.loader).toMatch(/\.eq\("status", "succeeded"\)\s*\.eq\("stripe_livemode", livemode\)/);
  });

  it("the mode comes from inferStripeLivemode, never from a literal", () => {
    expect(CODE.loader).toContain("inferStripeLivemode()");
    // A hard-coded mode would show a test deployment nothing and would show
    // production the wrong ledger the day the key changes.
    expect(CODE.loader).not.toMatch(/stripe_livemode",\s*(true|false)/);
  });

  it("the Stripe SDK is NOT imported — only the mode flag, from the leaf module", () => {
    expect(CODE.loader).toContain('from "@/lib/stripe/livemode"');
    expect(ALL_CODE).not.toMatch(/from ["']@\/lib\/stripe\/server["']/);
    expect(ALL_CODE).not.toMatch(/from ["']stripe["']/);
    const leaf = codeOnly(read("lib/stripe/livemode.ts"));
    expect(leaf, "the leaf module must import nothing").not.toContain("import ");
  });

  it("EVERY appointment_settlements read excludes superseded rows", () => {
    const reads = CODE.loader.split('.from("appointment_settlements")').slice(1);
    expect(reads.length).toBeGreaterThanOrEqual(1);
    for (const r of reads) {
      // A superseded row is a correction's predecessor. Summing it counts the
      // correction twice.
      expect(r.slice(0, 400)).toContain('.is("superseded_at", null)');
    }
  });

  it("charges and refunds are windowed on their OWN columns, independently", () => {
    // A refund can fall in a different period from the charge it reverses.
    // Windowing both on `charged_at` would move money between periods.
    expect(CODE.loader).toContain('.gte("charged_at", startUtc)');
    expect(CODE.loader).toContain('.lt("charged_at", endUtc)');
    expect(CODE.loader).toContain('.gte("refunded_at", startUtc)');
    expect(CODE.loader).toContain('.lt("refunded_at", endUtc)');
    expect(CODE.loader).toContain('.eq("refund_status", "succeeded")');
  });

  it("no read filters an unbounded id list into the URL", () => {
    // Building `.in("appointment_id", [...])` from a period's appointments is
    // unbounded in the period length, and an over-long generated URL is a live
    // production failure mode on this codebase, not a hypothetical one.
    expect(CODE.loader).not.toMatch(/\.in\(/);
  });
});

describe("NC3 — the three evidence classes are never summed into one another", () => {
  it("no arithmetic joins card money, attested money and service value", () => {
    // The census exposes each class as its own field and offers no total. A
    // reader wanting one has to write the addition themselves, in the open.
    for (const forbidden of [
      /collectedGrossCents\s*\+\s*externallyAttestedCents/,
      /externallyAttestedCents\s*\+\s*collectedGrossCents/,
      /collected\w*\s*\+\s*serviceValue/i,
      /serviceValue\w*\s*\+\s*collected/i,
      /totalMoney|totalCollected|allMoney|grandTotal/i,
    ]) {
      expect(ALL_CODE, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("the collection rate is a VISIT-COUNT ratio, never a dollar ratio", () => {
    // The numerator would be an operator-authored till total and the
    // denominator a mutable menu price. That quotient is not a rate.
    expect(CODE.model).toContain("cardPaidChargeable / chargeable.size");
    for (const forbidden of [
      /collected\w*Cents\s*\/\s*\w*serviceValue/i,
      /serviceValue\w*\s*\/\s*collected/i,
      /collectionRate\w*\s*=\s*[^;]*Cents\s*\//i,
    ]) {
      expect(ALL_CODE, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("price_paid_cents is never summed into a money total", () => {
    // It carries no date, no method and no provenance, and in production every
    // populated row sits on a session with no appointment. It is not a payment
    // record and cannot be added to one.
    expect(ALL_CODE).not.toContain("price_paid_cents");
  });

  it("buffer is read per appointment, never recomputed from the studio setting", () => {
    // `studios.buffer_minutes` is a single CURRENT value; production carries
    // per-appointment snapshots of both 15 and 20 minutes, so recomputing from
    // the studio setting is wrong on every row booked under the other one.
    expect(CODE.loader).toContain("blocked_ends_at");
    expect(ALL_CODE).not.toContain("buffer_minutes");
    expect(ALL_CODE).not.toContain("buffer_minutes_snapshot");
  });

  it("no timezone-bearing date_trunc is pushed into SQL", () => {
    // A second timezone implementation already made the dashboard and the
    // calendar disagree by a full week every Sunday. Bucketing happens in
    // TypeScript, off the one period contract.
    expect(ALL_CODE.toLowerCase()).not.toContain("date_trunc");
    expect(ALL_CODE).not.toContain("at time zone");
  });
});

describe("NC5 — a reversed payment is not a collection, an absent one is not a zero", () => {
  it("collection-rate membership is decided AFTER netting, never when the charge lands", () => {
    // THE DEFECT: `cardPaid.add(id)` sat inside the charge loop, before the
    // refund was read. A visit charged and then refunded in full counted as
    // collected, so the screen printed "1 visit paid by card / 100.0%" directly
    // above "Collected by card, after refunds: $0.00" — and claimed the account
    // was complete. It also kept the visit out of "No payment recorded", so it
    // appeared in no honest line at all.
    //
    // NOT AN EDGE CASE: lib/billing/payment-refund.ts writes full reversals
    // only, so a net of zero is the shape of EVERY refund Hone can issue.
    expect(CODE.model).toMatch(/net\s*>\s*0\)\s*cardPaid\.add/);
    expect(CODE.model).not.toMatch(
      /deliveredTreatment\.has\(id\)\)\s*continue;\s*cardPaid\.add/,
    );
  });

  it("a reversed visit gets its own line rather than either false sentence", () => {
    expect(CODE.model).toContain("refundedToZeroVisits");
    expect(CODE.spine).toContain("refundedToZeroVisits");
    expect(CODE.copy).toContain("REFUNDED_TO_ZERO_EXPLAINED");
    expect(CODE.spine).toContain("REFUNDED_TO_ZERO_EXPLAINED");
  });

  it("the attested gate asks about THIS WINDOW, never the studio's all-time rows", () => {
    // Settlements are read studio-wide, so gating on `input.settlements.length`
    // let the FIRST settlement a studio ever wrote turn every OTHER window's
    // external money into a confident $0.00 — the exact sentence Operator
    // decision 4 exists to prevent, printed in every unsettled period.
    expect(CODE.model).toContain("const nothingAttested = attestedRows === 0;");
    expect(CODE.model).not.toContain("input.settlements.length === 0");
  });

  it("settlements are narrowed against every delivered visit, not treatment only", () => {
    // Cash a practitioner wrote down for a delivered CONSULTATION is attested
    // money. Narrowing to treatment dropped it from the external total.
    expect(CODE.model).toContain("deliveredAny.has(s.appointment_id)");
    expect(CODE.model).not.toContain("deliveredTreatment.has(s.appointment_id)");
  });

  it("no sentence tells the owner a settlement names a visit OUTSIDE this window", () => {
    // It was false for a payment recorded against a delivered consultation —
    // on a screen already showing that consultation inside the window.
    expect(ALL_CODE).not.toContain("a visit outside this window");
  });
});

describe("NC6 — past work is valued at the price on record, never at today's menu", () => {
  it("the settlement read asks for the 0187 price snapshot", () => {
    // The column exists FOR this surface: "without the snapshot, a service
    // repriced in March silently rewrites what February's completed visits
    // were worth, and FIN-01A's collection rate drifts away from what Checkout
    // actually showed" (0187, quoted_amount_cents).
    expect(CODE.loader).toContain("quoted_amount_cents");
  });

  it("the recorded price WINS over services.price_cents", () => {
    // `services.price_cents` is a single CURRENT value. Using it for past work
    // is the same defect `blocked_ends_at` is read per appointment to avoid.
    expect(CODE.model).toContain("recordedPrice ?? finite(service?.price_cents)");
  });

  it("the fallback is NULLISH, so a recorded price of zero survives", () => {
    // `quoted_amount_cents >= 0` is legal and means the visit was quoted
    // nothing. `||` would discard that and silently re-price it from the menu.
    expect(CODE.model).not.toMatch(/recordedPrice\s*\|\|/);
  });

  it("no sentence claims Hone keeps no record of the price at the time", () => {
    // It kept one from 0187 onward, and said so in the column comment.
    expect(ALL_CODE).not.toContain("Hone does not keep the price a visit carried at the time");
    expect(CODE.copy).toContain("SERVICE_VALUE_PRICE_BASIS");
    expect(CODE.spine).toContain("SERVICE_VALUE_PRICE_BASIS");
  });

  it("the screen says when the two price bases are MIXED", () => {
    expect(CODE.model).toContain("visitsValuedAtRecordedPrice");
    expect(CODE.spine).toContain("visitsValuedAtRecordedPrice");
    expect(CODE.spine).toContain("SOME_VISITS_PRICED_AT_THE_TIME");
  });
});

describe("P2-A — consultation is decided by the shared predicate, never by price", () => {
  it("FIN imports the SAME predicate the booking page and its server guard use", () => {
    expect(CODE.model).toContain('from "@/lib/booking/consultation"');
    expect(CODE.model).toContain("isConsultationService");
  });

  it("EVERY price comparison in the model is one of the three that may exist", () => {
    // AN ENUMERATION, NOT A DENYLIST, and the reason is the defect this
    // replaced. The old code classified with `if (price === 0)` — a LOCAL. A
    // denylist written against the column name (`price_cents === 0`) would
    // never have matched it, and a future author reintroducing the defect would
    // reach for the local again. Pinning the exact SET means any new price
    // comparison fails here and has to be justified in the open, whatever it is
    // spelled.
    //
    // The three permitted comparisons all answer "what was this worth", never
    // "what was this":
    //   === null  ->  cannot be valued
    //   !== null  ->  a consultation's own value line
    //   > 0       ->  there was something to collect
    const comparisons = [
      ...CODE.model.matchAll(/[^\n]*\bprice\w*\s*(===|!==|>=|<=|>|<)[^\n]*/g),
    ].map((m) => m[0].trim());
    expect(comparisons).toEqual([
      "if (price !== null) consultationServiceValueCents += price;",
      "if (price === null) {",
      "if (price > 0) chargeable.set(row.id, price);",
    ]);
  });

  it("THE PREDICATE'S OWN BODY never mentions price, whatever the spelling", () => {
    // `classifyService` is the authority. If price cannot reach it, no spelling
    // of a price test can decide what a visit is.
    const start = CODE.model.indexOf("export function classifyService(");
    expect(start).toBeGreaterThan(-1);
    const body = CODE.model.slice(start, CODE.model.indexOf("\n}", start));
    expect(body).not.toMatch(/price/i);
    expect(body).toContain("isConsultationService");
  });

  it("the consultation branch is keyed on the CLASS, never on a value", () => {
    expect(CODE.model).toContain('if (serviceClass === "consultation")');
    expect(CODE.model).toContain('if (serviceClass === "unknown")');
    // And a price test never gates a classification, in either spelling.
    expect(ALL_CODE).not.toMatch(
      /\bprice\w*\s*(===|!==)\s*0\s*\)[\s\S]{0,80}?(consultation|treatment)/i,
    );
  });

  it("the predicate's own inputs are read, and nothing else", () => {
    // `isConsultationService` reads modality and name. The projection has to
    // carry both or the predicate silently degrades to its name fallback — or,
    // worse, to `unknown` for every row.
    expect(CODE.loader).toContain('.select("id, name, modality, price_cents"');
  });

  it("price decides ONLY whether there was something to collect", () => {
    expect(CODE.model).toContain("if (price > 0) chargeable.set(row.id, price)");
    // ...and the collection rate divides by THAT set, not by delivered visits.
    expect(CODE.model).toContain("chargeable.size === 0");
  });

  it("a missing service is UNKNOWN, not silently treatment", () => {
    expect(CODE.model).toContain('if (!service) return "unknown"');
    expect(CODE.model).toContain("unclassifiable");
  });
});

describe("P2-B / P2-C — the two money contracts are named apart and never merged", () => {
  it("the per-hour rate divides one population by itself", () => {
    // Numerator and denominator are accumulated in the SAME loop over the same
    // visits, so they cannot describe different periods.
    expect(CODE.model).toContain(
      "collectedOnDeliveredCents / (collectedOnDeliveredMinutes / 60)",
    );
  });

  it("the cash-movement net NEVER feeds the per-hour rate", () => {
    // The refuted form: cash-movement net (charged_at-windowed, minus
    // refunded_at-windowed refunds) over delivered-visit hours. Those are
    // different populations, so the quotient was a rate of nothing.
    for (const forbidden of [
      /netMovementCents\s*\/\s*/,
      /movedInGrossCents\s*\/\s*/,
      /perTreatmentHour\w*\s*=\s*[^;]*netMovement/,
      /perTreatmentHour\w*\s*=\s*[^;]*treatmentBookedMinutes/,
    ]) {
      expect(ALL_CODE, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("a service-period charge is netted by ITS OWN refund, not by a window", () => {
    expect(CODE.model).toContain('c.refund_status === "succeeded"');
    // The charge read has to carry the refund columns for that to be possible.
    expect(CODE.loader).toContain("refund_amount_cents, refund_status");
  });

  it("cross-period reversals are COUNTED, so the caveat is measured not asserted", () => {
    expect(CODE.model).toContain("refundsReversingOtherPeriods");
    // `charged_at` on the refund read is what makes the comparison possible.
    expect(CODE.loader).toContain('.select("refund_amount_cents, charged_at"');
    expect(CODE.spine).toContain("refundsReversingOtherPeriods");
  });

  it("the two contracts carry DIFFERENT owner-facing names", () => {
    expect(CODE.spine).toContain("Card money that moved this period");
    expect(CODE.spine).toContain("Collected on treatment delivered in this window");
    // No surviving name that would read as one overloaded number.
    expect(CODE.spine).not.toContain("Net of refunds");
    expect(ALL_CODE).not.toContain("collectedNetCents");
  });

  it("both contracts publish the sentence that says what they are NOT", () => {
    expect(CASH_MOVEMENT_IS_NOT_EARNINGS).toMatch(/not what this period.s work earned/);
    expect(COLLECTED_ON_DELIVERED_IS_ONE_POPULATION).toMatch(/same visits/);
    expect(CODE.spine).toContain("CASH_MOVEMENT_IS_NOT_EARNINGS");
    expect(CODE.spine).toContain("COLLECTED_ON_DELIVERED_IS_ONE_POPULATION");
  });
});

describe("P2-D — the unattributed count is all-time, and says so", () => {
  it("it is NOT inside the windowed money census", () => {
    // It sat beside the windowed figures in the first draft, where it read as
    // a claim about the chosen period.
    expect(CODE.model).not.toContain("unattributedCharges");
  });

  it("it travels on the briefing, explicitly named all-time", () => {
    expect(CODE.loader).toContain("unattributedChargesAllTime");
    expect(CODE.spine).toContain("unattributedChargesAllTime");
    expect(CODE.spine).toMatch(/\(all time\)/);
    expect(UNATTRIBUTED_IS_ALL_TIME).toMatch(/all time, not this period/);
  });

  it("no window is invented for it from created_at", () => {
    // `created_at` records when the ATTEMPT ROW was written, not when money
    // moved. Windowing by it would file real money into a period on a guess.
    expect(CODE.loader).not.toContain("created_at");
  });

  it("it is still SURFACED — dropping it would deny money that was made", () => {
    expect(CODE.loader).toContain('.is("charged_at", null)');
    expect(CODE.spine).toContain("UnattributedAllTime");
  });

  it("its read is INDEPENDENT of the money window, structurally", () => {
    // It used to ride inside the ledger bundle, so a period below the money
    // floor suppressed an ALL-TIME figure for a reason that had nothing to do
    // with it. Its own reader makes the independence structural rather than a
    // comment, and that reader takes no window arguments at all.
    expect(CODE.loader).toContain("async function readUnattributedChargeCount(");
    const reader = CODE.loader.slice(
      CODE.loader.indexOf("async function readUnattributedChargeCount("),
    );
    const body = reader.slice(0, reader.indexOf("\n}"));
    expect(body).toContain('.is("charged_at", null)');
    for (const windowed of ["startUtc", "endUtc", "moneyStartUtc", '.gte(', '.lt(']) {
      expect(body, windowed).not.toContain(windowed);
    }
  });

  it("NEVER reports its absence as not_yet_supported", () => {
    // That cause's sentence says Hone can answer this and does not answer it
    // yet. Hone answers it in every period, so the sentence would be false —
    // which is the one thing this whole surface exists to prevent.
    expect(CODE.loader).not.toContain("not_yet_supported");
    expect(UNKNOWN_EXPLANATION.not_yet_supported).toMatch(/later release/);
  });

  it("an UNKNOWN count does not render identically to a zero one", () => {
    // Returning null for both made "Hone could not look" indistinguishable
    // from "there are none" — the same collapse financial-copy.ts refuses when
    // it rejects a shared "Not available".
    expect(CODE.spine).toContain("if (fact.known && fact.value === 0) return null;");
    expect(CODE.spine).not.toContain("if (!fact.known || fact.value === 0) return null;");
    const section = CODE.spine.slice(CODE.spine.indexOf("function UnattributedAllTime("));
    expect(section.slice(0, section.indexOf("\n}"))).toContain("<Unknown cause={fact.cause} />");
  });
});

describe("NC-snapshot — one instant, passed as a parameter", () => {
  it("the loader reads the clock exactly ONCE", () => {
    expect((CODE.loader.match(/new Date\(\)/g) ?? []).length).toBe(1);
  });

  it("no pure module reads a clock at all", () => {
    for (const key of ["model", "fact", "copy", "spine"] as const) {
      expect(CODE[key], key).not.toMatch(/new Date\(\)|Date\.now\(\)/);
    }
  });

  it("the snapshot reaches the model as an argument, and reaches the screen", () => {
    expect(CODE.model).toContain("snapshot: Date");
    expect(CODE.loader).toContain("evidenceInstant: now.toISOString()");
    // ON SCREEN, not in a tooltip: two reports minutes apart legitimately
    // disagree, and without the instant that reads as a broken system.
    expect(CODE.spine).toContain("briefing.evidenceInstant");
  });
});

// ---------------------------------------------------------------------------
// 2. UNKNOWN cannot become zero
// ---------------------------------------------------------------------------

describe("NC4/NC9 — an absence has no coercion route to a number", () => {
  it("there is no valueOr / getOrElse / unwrapOr helper anywhere", () => {
    // A coercion helper is the single mechanism by which "we could not read
    // this" becomes "$0.00", and once it exists somebody reaches for it.
    expect(ALL_CODE).not.toMatch(/\b(valueOr|getOrElse|unwrapOr|orZero|orDefault)\b/);
  });

  it("no fact is defaulted with ?? or || to a number or a currency string", () => {
    expect(ALL_CODE).not.toMatch(/\.value\s*(\?\?|\|\|)/);
    expect(ALL_CODE).not.toMatch(/(\?\?|\|\|)\s*["'`]\$?0/);
    // The I/O and render paths — where a Fact is in scope — carry no numeric
    // default at all. The rule is narrowed to them deliberately: a blanket ban
    // would also forbid the census counter below, which is a legitimate zero.
    for (const key of ["loader", "spine", "page", "fact", "copy"] as const) {
      expect(CODE[key], key).not.toMatch(/(\?\?|\|\|)\s*0\b/);
    }
  });

  it("the model's ONLY zero-default is the census counter, which is a real zero", () => {
    // `byStatus.get(status) ?? 0` means "this status had no rows in a read that
    // succeeded". That is `known(0)`, not a coerced unknown — and it is the one
    // place a literal zero may be written in the slice.
    const defaults = [...CODE.model.matchAll(/[^\n]*(\?\?|\|\|)\s*0\b[^\n]*/g)].map((m) =>
      m[0].trim(),
    );
    expect(defaults).toEqual([
      "byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);",
      "const count = (status: AppointmentStatusName) => known(byStatus.get(status) ?? 0);",
    ]);
  });

  it("no figure is rendered as a bare dash or an em dash placeholder", () => {
    expect(CODE.spine).not.toMatch(/>\s*[-—–]\s*</);
  });

  it("the render path narrows the union rather than reading .value unguarded", () => {
    // Every read of `.value` in the spine sits behind a `.known` check.
    expect(CODE.spine).toMatch(/if \(!fact\.known\) return <Unknown cause=\{fact\.cause\} \/>;/);
    expect(CODE.spine).toMatch(/calendar\.completed\.known \?/);
  });
});

// ---------------------------------------------------------------------------
// 3. The five causes stay five
// ---------------------------------------------------------------------------

describe("NC7/NC8 — the causes are not collapsed at the render boundary", () => {
  it("every cause has its own label, explanation and SHAPE", () => {
    for (const cause of ALL_CAUSES) {
      expect(UNKNOWN_LABEL[cause]).toBeTruthy();
      expect(UNKNOWN_EXPLANATION[cause]).toBeTruthy();
      // Colour is never the only channel: the mark map is exhaustive.
      expect(CODE.spine).toContain(`${cause}:`);
    }
  });

  it("no shared 'Not available' fallback survives anywhere", () => {
    expect(ALL_CODE).not.toMatch(/Not available/i);
  });

  it("the permanent framing lines are all rendered", () => {
    expect(CODE.spine).toContain("PERMANENT_LINES");
    expect(PERMANENT_LINES).toHaveLength(3);
    for (const line of PERMANENT_LINES) expect(line.length).toBeGreaterThan(40);
  });

  it("asserts no apply date for the historical boundary", () => {
    // docs/production/migration-state.json records 0187 with
    // hosted_applied_at: null and states no server apply instant was captured.
    // Printing one to an owner would claim precision the canonical record
    // explicitly declines to claim.
    // SCOPED TO THE SENTENCE IT IS ABOUT. Slice 2 states a date deliberately —
    // the record-keeping floor — and that is a different claim from an apply
    // instant. The rule is that the HISTORICAL BOUNDARY line carries no date,
    // because the canonical record explicitly declines to assert one.
    expect(HISTORY_BEFORE_OUTCOMES).not.toMatch(/\b20\d\d\b/);
    expect(HISTORY_BEFORE_OUTCOMES).not.toMatch(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/);
    // ...and no ISO instant is printed anywhere in copy, in any sentence: an
    // owner-facing date is a calendar date, never a timestamp.
    expect(SOURCE.copy).not.toMatch(/\b20\d\d-\d\d-\d\d\b/);
  });
});

// ---------------------------------------------------------------------------
// 3b. The screen claims only what the model guarantees
// ---------------------------------------------------------------------------
//
// The partition note printed "Every appointment in this period is on exactly
// one line above" whenever `partition.closed`. Codex raised it on PR #646 and
// was right: `closed` means every appointment fell into one of the four KNOWN
// STATUSES, which is a claim about status coverage, while the sentence asserted
// a claim about ROW LAYOUT — and that one was false twice over. The total row
// period` is the total, so every appointment is on that line AND on its status
// line; and `completed` has no line in that section at all.
//
// Nothing caught it because every test asserted `partition.closed` — the model
// fact — and none asserted what the SENTENCE told the owner. These do.

/**
 * The two sentences `PartitionNote` can render, extracted INDEPENDENTLY of each
 * other from the AST.
 *
 * The first version of this guard searched a 1200-character slice of the source
 * around `PartitionNote`, which spans BOTH return branches. Codex raised it on
 * #646 and was right: a status word deleted from one sentence still appeared in
 * the other, so the assertion could not fail. Verified before repairing —
 * removing `completed` from the coverage sentence, `cancelled` from it, or
 * `no-show` from the withdrawal sentence each left the suite green.
 *
 * Worse, my own negative control had hidden it. The control that was meant to
 * prove the four-status assertion removed a status AND the next-section pointer
 * in one edit, so it went red for the pointer and read as though the status
 * assertion had fired. A control that changes two facts proves neither.
 *
 * So the branches are now separated structurally rather than by proximity: the
 * coverage message is the return inside `if (partition.closed)`, the withdrawal
 * message is the function's final return, and each is asserted on its own text.
 * One branch cannot borrow a word from the other.
 */
function partitionMessages(): { coverage: string; withdrawal: string } {
  const sf = ts.createSourceFile(
    FILES.spine,
    SOURCE.spine,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  );

  let fn: ts.FunctionDeclaration | undefined;
  const findFn = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "PartitionNote") fn = node;
    ts.forEachChild(node, findFn);
  };
  findFn(sf);
  if (!fn?.body) throw new Error("PartitionNote not found — this guard cannot run");

  /** The prose a viewer reads: JSX text only, whitespace collapsed. */
  const visibleText = (node: ts.Node): string => {
    const parts: string[] = [];
    const walk = (n: ts.Node): void => {
      if (ts.isJsxText(n)) parts.push(n.text);
      ts.forEachChild(n, walk);
    };
    walk(node);
    return parts.join(" ").replace(/\s+/g, " ").trim();
  };

  let coverage: string | undefined;
  let withdrawal: string | undefined;
  for (const statement of fn.body.statements) {
    if (
      ts.isIfStatement(statement) &&
      statement.expression.getText(sf).includes("partition.closed")
    ) {
      coverage = visibleText(statement.thenStatement);
    } else if (ts.isReturnStatement(statement) && statement.expression) {
      withdrawal = visibleText(statement);
    }
  }
  if (!coverage) throw new Error("no `if (partition.closed)` branch — the gate is gone");
  if (!withdrawal) throw new Error("no withdrawal branch — the retraction is gone");
  return { coverage, withdrawal };
}

/**
 * The CLAIM sentence within a message: the one that says what accounts for what.
 *
 * Asserting the statuses against the whole coverage message was still too
 * loose, and a one-fact-at-a-time control caught it: deleting `completed` from
 * the enumeration left the message false — "Still to happen, cancelled and
 * no-show account for every appointment in this period" — while the word survived in
 * the pointer sentence, "Completed is counted in the next section", so the
 * assertion stayed green. The enumeration is the thing making the claim, so the
 * enumeration is what gets asserted.
 */
function claimSentence(message: string): string {
  const sentence = message
    .split(/(?<=\.)\s+/)
    .find((part) => /account for every appointment/i.test(part));
  if (!sentence) throw new Error(`no claim sentence in: ${message}`);
  return sentence;
}

/**
 * The four statuses AS THE OWNER SEES THEM.
 *
 * `confirmed` is deliberately absent. The screen never uses that word: the row
 * is labelled "Still to happen", and `stillToHappen: count("confirmed")` is
 * where the model does the translation. Asserting "confirmed" would force copy
 * to satisfy a test rather than describe the product, so the vocabulary here is
 * the rendered one and matches the row labels above it.
 */
const PARTITION_STATUS_WORDS = ["still to happen", "completed", "cancelled", "no-show"];

describe("NC-claim — the partition note states status coverage, not row layout", () => {
  const messages = partitionMessages();
  const normalise = (text: string) => text.toLowerCase();

  it("EXTRACTION IS REAL: the two messages are distinct, non-trivial prose", () => {
    // If extraction silently returned "" for either branch, every assertion
    // below would pass vacuously — which is the shape of the bug being fixed.
    expect(messages.coverage.length).toBeGreaterThan(40);
    expect(messages.withdrawal.length).toBeGreaterThan(40);
    expect(messages.coverage).not.toEqual(messages.withdrawal);
    // ...and neither contains the other, so "independent" is literal.
    expect(messages.coverage.includes(messages.withdrawal)).toBe(false);
    expect(messages.withdrawal.includes(messages.coverage)).toBe(false);
  });

  it.each(PARTITION_STATUS_WORDS)("the COVERAGE claim enumerates %s", (word) => {
    // The CLAIM sentence, not the whole message: the pointer sentence also says
    // "Completed", and letting that satisfy this would re-open the hole.
    const claim = claimSentence(messages.coverage);
    expect(normalise(claim), claim).toContain(word);
  });

  it.each(PARTITION_STATUS_WORDS)("the WITHDRAWAL claim enumerates %s", (word) => {
    // Asserted against the withdrawal text ALONE. Before this repair the same
    // word in the coverage sentence would have satisfied it.
    const claim = claimSentence(messages.withdrawal);
    expect(normalise(claim), claim).toContain(word);
  });

  it("makes no claim that a line-by-line reading is exact", () => {
    // The exact false sentence, and the family it belongs to. A layout claim is
    // unprovable from a status census however it is phrased.
    expect(CODE.spine).not.toMatch(/exactly one line/i);
    expect(CODE.spine).not.toMatch(/on (exactly )?one (line|row)/i);
    expect(CODE.spine).not.toMatch(/each appointment appears once/i);
  });

  it("the COVERAGE message says where the fourth count is shown", () => {
    // `completed` is rendered in "Work actually completed". A claim covering it
    // that did not say so would send the owner looking for a row that is not
    // there. Deliberately a SEPARATE test from the status words, so removing
    // the pointer can never read as proof that a status assertion fired.
    expect(normalise(messages.coverage)).toMatch(/next section/);
  });

  it("the calendar section really does NOT carry a completed row", () => {
    const calendarSection = CODE.spine.indexOf("The calendar");
    const completedSection = CODE.spine.indexOf("Work actually completed");
    expect(calendarSection).toBeGreaterThan(-1);
    expect(completedSection).toBeGreaterThan(calendarSection);
    const calendarRows = CODE.spine.slice(calendarSection, completedSection);
    expect(calendarRows).toContain('label="Appointments in this period"');
    expect(calendarRows).not.toContain('label="Completed"');
  });

  it("NO OWNER-FACING COPY CALLS THE TOTAL 'BOOKED'", () => {
    // The total counts EVERY appointment record whose start falls in the
    // period — cancelled and no-show included, and rows whose status this build
    // does not recognise too. "Booked in this period" read as work the studio
    // had on; measured on production 2026-08-27, August showed 92 while 18 of
    // them were cancelled, so the label overstated the month by roughly a
    // fifth. It now claims only what the count is.
    //
    // Scoped to the RENDERED COPY, deliberately. The model field is still
    // called `booked`, which is an identifier the owner never sees, so a
    // whole-file search would fail on the wrong thing and force a refactor this
    // repair does not need.
    const calendarSection = CODE.spine.indexOf("The calendar");
    const completedSection = CODE.spine.indexOf("Work actually completed");
    const calendarRows = CODE.spine.slice(calendarSection, completedSection);
    const labels = [...calendarRows.matchAll(/label="([^"]+)"/g)].map((m) => m[1]);

    // ANTI-VACUITY: the extraction found the real rows, not an empty list.
    expect(labels).toContain("Appointments in this period");
    expect(labels).toContain("Still to happen");
    expect(labels.length).toBeGreaterThanOrEqual(5);

    for (const label of labels) {
      expect(normalise(label), label).not.toMatch(/book/);
    }
    expect(normalise(messages.coverage)).not.toMatch(/book/);
    expect(normalise(messages.withdrawal)).not.toMatch(/book/);
  });

  it("the total's label claims NOTHING about outcome, money or attendance", () => {
    // The words this label may never use. Each would assert something the
    // count does not establish: it is not a confirmed-only figure, not work
    // that happened, and carries no money meaning whatsoever.
    const calendarSection = CODE.spine.indexOf("The calendar");
    const completedSection = CODE.spine.indexOf("Work actually completed");
    const calendarRows = CODE.spine.slice(calendarSection, completedSection);
    const total = [...calendarRows.matchAll(/label="([^"]+)"/g)][0][1];
    expect(total).toBe("Appointments in this period");
    for (const forbidden of [
      "booked",
      "confirmed",
      "completed",
      "revenue",
      "paid",
      "attended",
      "earned",
      "income",
    ]) {
      expect(normalise(total), total).not.toContain(forbidden);
    }
  });

  it("the claim is printed ONLY when the model says it holds", () => {
    expect(CODE.spine).toContain("if (partition.closed)");
    expect(CODE.spine).toContain("if (!booked.known) return null;");
  });

  it("THE FACT ITSELF: the five categories really do sum to booked when closed", () => {
    // The arithmetic the sentence asserts, proved against the model rather than
    // assumed from its name. No `if (known)` guard: an unknown fact must FAIL
    // this, not silently skip it.
    //
    // FIVE, not four: `confirmed` now splits on time into still-to-happen and
    // past-still-confirmed, so a four-term sum would no longer reach `booked`.
    // Each fixture below is placed on BOTH sides of the reference instant, so
    // the identity is asserted over a census that actually exercises the split
    // rather than one that keeps every row on one side of it.
    const REF = new Date("2026-08-27T12:00:00.000Z");
    const BEFORE = "2026-08-27T11:00:00.000Z";
    const AFTER = "2026-08-27T13:00:00.000Z";
    for (const statuses of [
      ["confirmed", "completed", "cancelled", "no_show"],
      ["completed", "completed", "completed"],
      [],
      ["cancelled", "no_show", "no_show", "confirmed", "completed", "completed"],
      ["confirmed", "confirmed", "confirmed"],
    ]) {
      const census = summarizeCalendar(
        statuses.map((status, i) => ({ status, starts_at: i % 2 === 0 ? BEFORE : AFTER })),
        REF,
      );
      expect(census.partition.closed, statuses.join(",")).toBe(true);
      const parts = [
        census.stillToHappen,
        census.pastConfirmed,
        census.completed,
        census.cancelled,
        census.noShow,
      ];
      expect(parts.every((f) => f.known)).toBe(true);
      expect(census.booked.known).toBe(true);
      const sum = parts.reduce((total, f) => total + (f.known ? f.value : NaN), 0);
      expect(sum, statuses.join(",")).toBe(census.booked.known ? census.booked.value : NaN);
    }
  });

  it("and the withdrawal is what the model asks for when it does NOT hold", () => {
    const census = summarizeCalendar(
      [
        { status: "rescheduled", starts_at: "2026-08-27T13:00:00.000Z" },
        { status: "completed", starts_at: "2026-08-27T11:00:00.000Z" },
      ],
      new Date("2026-08-27T12:00:00.000Z"),
    );
    expect(census.partition.closed).toBe(false);
    expect(census.partition.unrecognisedStatuses).toEqual(["rescheduled"]);
    expect(normalise(messages.withdrawal)).toMatch(
      /do not account for every appointment in this period/,
    );
  });
});


// ---------------------------------------------------------------------------
// 4. Authority
// ---------------------------------------------------------------------------

describe("NC-auth — the gate precedes the read, and claims no more than it is", () => {
  it("the role refusal is the FIRST statement of the loader", () => {
    // Not merely present: first. A read issued before the check is an aggregate
    // payload a practitioner caused, whatever the page then renders.
    expect(CODE.loader).toMatch(
      /Promise<FinancialsView>\s*\{\s*if \(practitioner\.role !== "owner"\) return \{ access: "refused" \};/,
    );
  });

  it("the page refuses before it renders the spine", () => {
    const refusal = CODE.page.indexOf('view.access === "refused"');
    const spine = CODE.page.indexOf("<FinancialSpine");
    expect(refusal).toBeGreaterThan(-1);
    expect(spine).toBeGreaterThan(refusal);
  });

  it("does not describe itself as a database boundary", () => {
    const claims = /owner-only (data|database|row) boundary|RLS[^.]{0,40}owner/i;
    expect(SOURCE.loader).not.toMatch(claims);
    expect(SOURCE.page).not.toMatch(claims);
  });

  it("states in source that the gate is application-layer only", () => {
    // Prose wraps across comment lines, so strip the markers before matching.
    const prose = SOURCE.loader.replace(/^\s*(\/\/|\*)/gm, " ").replace(/\s+/g, " ");
    expect(prose).toMatch(/is_studio_member/);
    expect(prose).toMatch(/NOT a database boundary/i);
    expect(prose).toMatch(/decides who is SHOWN the aggregate/i);
  });

  it("financial truth is never cached", () => {
    expect(CODE.page).toContain('export const dynamic = "force-dynamic"');
  });
});

// ---------------------------------------------------------------------------
// 5. Read-only
// ---------------------------------------------------------------------------

describe("NC-readonly — no mutation, no RPC, no schema", () => {
  it.each([".insert(", ".update(", ".delete(", ".upsert(", ".rpc("])(
    "no %s anywhere in the slice",
    (verb) => {
      expect(ALL_CODE).not.toContain(verb);
    },
  );

  it("no migration, trigger or policy text is introduced by the slice", () => {
    expect(ALL_CODE).not.toMatch(/create (table|policy|index|function)/i);
  });
});

// ---------------------------------------------------------------------------
// 6. Responsive and accessible
// ---------------------------------------------------------------------------

describe("NC-mobile/a11y — order carries the meaning, colour never does", () => {
  it("the provenance chain cannot be re-sequenced by a viewport", () => {
    // No grid, no CSS ordering, no reversal: stacking a single column cannot
    // change the reading order of calendar -> anchor -> what became of it.
    expect(CODE.spine).not.toMatch(/\border-\d/);
    expect(CODE.spine).not.toMatch(/\b(flex-row-reverse|flex-col-reverse)\b/);
    expect(CODE.spine).not.toMatch(/\bgrid-cols-/);
  });

  it("renders the sections in the frozen Direction B order", () => {
    // Direction B's spine, now that the money sections are real. The three
    // evidence classes appear in provenance order — what Hone VERIFIED, then
    // what a practitioner ATTESTED, then what is only a PRICE — so a reader
    // who stops early stops on the strongest evidence, not the weakest.
    // Provenance order, now that the money contracts are named apart: what
    // MOVED (transaction period), then what this window's delivered work
    // COLLECTED (service period), then what was only ATTESTED, then what is
    // only a PRICE. A reader who stops early stops on the strongest evidence.
    const order = [
      "The calendar",
      "Work actually completed",
      "Delivered in this window",
      "Card money that moved this period",
      "Collected on treatment delivered in this window",
      "Collected outside Hone",
      "Service value of delivered work",
      "Visits with a payment recorded",
      "Where the clinic time went",
    ].map((heading) => CODE.spine.indexOf(heading));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("nothing is pinned to a fixed pixel width that could overflow a phone", () => {
    expect(CODE.spine).not.toMatch(/(?<![\w-])w-\[\d+px\]/);
    expect(CODE.spine).toContain("max-w-[920px]");
    // Flex children that hold prose declare min-w-0, or a long word forces the
    // row wider than the viewport instead of wrapping.
    expect(CODE.spine).toContain("min-w-0");
  });

  it("headings are real headings, not styled captions", () => {
    const h2s = CODE.spine.match(/<SectionLabel as="h2">/g) ?? [];
    expect(h2s.length).toBeGreaterThanOrEqual(4);
    expect((CODE.spine.match(/<h1/g) ?? []).length).toBe(1);
  });

  it("load-bearing financial explanation never rides on muted-over-sunken", () => {
    // Measured 4.54:1 — it clears AA by 0.04. Captions may use it; sentences
    // that carry the meaning of a missing figure may not.
    for (const [name, code] of Object.entries(CODE)) {
      for (const line of code.split("\n")) {
        const bad = line.includes("text-fg-muted") && line.includes("bg-surface-sunken");
        expect(bad, `${name}: ${line.trim()}`).toBe(false);
      }
    }
  });

  it("every decorative mark is hidden from assistive technology and paired with text", () => {
    expect(CODE.spine).toContain('aria-hidden="true"');
    expect(CODE.spine).toContain("UNKNOWN_LABEL[cause]");
  });

  it("the active period is announced, not only painted", () => {
    expect(CODE.spine).toMatch(/aria-current=\{active \? "page" : undefined\}/);
  });
});

// ---------------------------------------------------------------------------
// 7. Slice boundary
// ---------------------------------------------------------------------------

describe("NC-scope — the later slice is absent, and says so", () => {
  it("names the unbuilt capacity work in a sentence rather than a zero", () => {
    expect(CODE.spine).toContain("CAPACITY_NOT_YET");
    expect(CAPACITY_NOT_YET).toMatch(/not on this screen/);
  });

  it("NO capacity, utilisation, forecast or client projection shipped", () => {
    // The packet defers all of these. Each needs blocked-out time, interval
    // merging and an elapsed denominator, and an approximation of any of them
    // would be read as an answer.
    for (const forbidden of [
      "studio_timed_blocks",
      "studio_blockouts",
      "studio_availability_default",
      "studio_availability_overrides",
      "studio_recurring_break_rules",
      "utilisation",
      "utilization",
      "sellable",
      "sustainable",
      "forecast",
      "scenario",
      "spareCapacity",
      "perOpenHour",
      "halfDay",
      "fullDay",
    ]) {
      expect(ALL_CODE.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
  });

  it("REGISTERS the route, and this assertion is the inverse of the one it replaced", () => {
    // INVERTED DELIBERATELY, NOT DELETED. Through Slice 1 and Slice 2 this
    // test asserted the OPPOSITE — that /financials carried no NAV_ENTRIES row
    // and sat in NON_SEARCHABLE_ROUTES — because the surface named figures it
    // could not yet show, and advertising it would have resolved an owner's
    // search to a disappointment.
    //
    // This release is the registration slice those comments named. The guard
    // is turned around rather than removed, so the file still has an opinion
    // about the route's discoverability and a future change that silently
    // un-registers it fails here.
    const registry = read("lib/search/navigation-registry.ts");
    // SLICED ON THE DECLARATION, NOT THE FIRST MENTION. `NON_SEARCHABLE_ROUTES`
    // appears in a header comment on line 32, so slicing at indexOf() of the
    // bare name cut the "nav entries" region down to 32 lines of prose. The
    // assertion this replaced was `.not.toContain`, which passed against that
    // empty slice for the wrong reason and would never have failed. Anchoring
    // on the export makes the region real.
    const navEntries = registry.slice(
      0,
      registry.indexOf("export const NON_SEARCHABLE_ROUTES"),
    );
    expect(navEntries).toContain('href: "/financials"');
    expect(registry).not.toContain('route: "/financials"');
  });

  it("is owner-visible in search, never practitioner-visible", () => {
    // Search visibility must match the server gate. A practitioner who cannot
    // open the page must not be offered it by the search box either — not
    // because search is the boundary (it is not; the page's own role check is)
    // but because offering a destination that refuses on arrival is a defect
    // in its own right.
    const registry = read("lib/search/navigation-registry.ts");
    const start = registry.indexOf('id: "financials"');
    expect(start).toBeGreaterThan(-1);
    const entry = registry.slice(start, registry.indexOf("},", start));
    expect(entry).toContain('visibility: "owner"');
  });

  it("never claims REVENUE, EARNINGS or INCOME in what the registry ASSERTS", () => {
    // The distinction this file exists to keep: a KEYWORD is a word the owner
    // types, a DESCRIPTION is a claim the product makes. "revenue" and
    // "earnings" are legitimate search aliases — that is how people talk about
    // money — but the description must not assert them, because cash and
    // e-transfer are invisible to Hone until somebody records them, so what
    // this surface shows is a FLOOR and never the whole of what was earned.
    const registry = read("lib/search/navigation-registry.ts");
    const start = registry.indexOf('id: "financials"');
    const entry = registry.slice(start, registry.indexOf("},", start));
    const description = /description:\s*\n?\s*"([^"]+)"/.exec(entry)?.[1] ?? "";
    expect(description.length).toBeGreaterThan(0);
    for (const claim of ["revenue", "earning", "income", "profit", "made"]) {
      expect(description.toLowerCase(), claim).not.toContain(claim);
    }
    // ...and it DOES say what it actually is.
    expect(description.toLowerCase()).toContain("collected by card through hone");
  });
});

// ---------------------------------------------------------------------------
// 8. What this file proves — and what it does not
// ---------------------------------------------------------------------------
//
// An earlier architecture here tried to prove a NEGATIVE: that no JavaScript
// expression anywhere in FIN's dependencies could load the money module. It did
// that by recognising the spellings a loader can take, and eleven review rounds
// each found one more — side-effect import, `require`, `(require)`, an
// instantiation expression, a conditional, a computed member key, a non-literal
// dynamic import, an explicit `.js` specifier, `createRequire`, a
// namespace-qualified `createRequire`, and finally `process.getBuiltinModule`,
// which needs no import at all. The file grew from 547 lines to 1764 while what
// it protected stayed one boolean.
//
// TRUTH-01A reached the same place in production and withdrew its own
// application-source reachability analyser for the same reason: "Enumerating
// the syntax of a language to prove a negative is the wrong shape of evidence
// for this slice" (#644, commit 47253256). This block is the FIN equivalent of
// that withdrawal, and the claim below is deliberately smaller than the one it
// replaces.
//
// PROVEN HERE
//
//   The TypeScript compiler, using this repository's own tsconfig, resolves
//   FIN's static ESM dependency graph — bundler semantics, `@/*` aliases,
//   extension substitution and package resolution all inherited rather than
//   imitated. Every module in the resulting closure is scanned for forbidden
//   money identifiers in VALUE POSITION, and none contains one. Position is the
//   boundary, not a file allowlist: `lib/types/database.ts` is in the closure
//   and does contain `price_cents`, `price_paid_cents` and `stripe_livemode`,
//   all of them `name: type` property signatures, because a file that DECLARES
//   the shape of a row names its columns. It passes on its merits.
//
//   A dependency site the compiler cannot resolve is a VIOLATION rather than an
//   absence, so the closure cannot shrink silently — which is the failure mode
//   that produced four of the eleven rounds.
//
// ENFORCED AS A CODING CONSTRAINT, NOT PROVEN HERE
//
//   In FIN-OWNED source — app/(app)/financials/** and lib/finance/** — three
//   stable ESLint rules reject loader forms including:
//
//     * a value-position `require`, `module` or `exports`, in any expression
//       shape (called, aliased, parenthesised, instantiated, conditional,
//       comma-sequenced, or as the object of a dotted, computed or
//       concatenated member);
//     * a STATIC import or re-export of "node:module" or "module", type-only
//       included;
//     * `process.getBuiltinModule`, dotted or with a literal computed key.
//
//   That lives in eslint.config.mjs and runs under `npm run lint` on every
//   diff. NC-lint below asserts the expected RULE ID fires for each example,
//   which shows those examples are rejected — not that the list is complete.
//
//   NOT covered by those rules, and therefore not claimed: `import("node:module")`
//   — core no-restricted-imports visits static declarations only — and
//   `globalThis.process.getBuiltinModule(...)` or an aliased `process`, since
//   no-restricted-properties matches only the literal `process` object. Those
//   are observations about the rules as configured today, not invariants: a
//   later lint change may start rejecting either, and nothing here defends the
//   gap.
//
// NOT CLAIMED
//
//   That arbitrary runtime module acquisition is impossible. It is not proven,
//   and this shape of evidence cannot prove it. Eleven of the seventeen modules
//   in the closure are shared infrastructure FIN does not own —
//   lib/supabase/server.ts alone has 96 importers — so no FIN-scoped coding
//   rule can bind them. For those, the money boundary is RLS and the owner
//   gate, not a source test.
//
// TYPE IMPORTS ARE FOLLOWED TOO. `import type` erases at runtime, so following
// it is stricter than the runtime graph — on purpose. The contract is about
// what this surface is COUPLED to, and `financial-spine.tsx` reached the money
// module through a type-only import alone.

/**
 * THE REPOSITORY'S OWN MODULE RESOLVER, not a hand-written approximation.
 *
 * A hand-rolled prober used to probe `x`, `x.ts`, `x.tsx`, `x/index.ts` by
 * hand, and missed that this repo compiles with `moduleResolution: "bundler"`,
 * under which `import "../dashboard/practice-metrics.js"` is a VALID import
 * resolving by extension substitution to the existing `.ts` file. The specifier
 * had been read perfectly; RESOLUTION is where the edge vanished.
 *
 * There is exactly ONE resolver in this file, and it is the compiler's.
 */
const COMPILER_OPTIONS: ts.CompilerOptions = (() => {
  const raw = ts.readConfigFile(path.join(ROOT, "tsconfig.json"), ts.sys.readFile);
  if (raw.error) {
    throw new Error(
      `cannot read tsconfig.json, so module resolution cannot be trusted: ${ts.flattenDiagnosticMessageText(raw.error.messageText, " ")}`,
    );
  }
  return ts.parseJsonConfigFileContent(raw.config, ts.sys, ROOT).options;
})();

const RESOLUTION_CACHE = ts.createModuleResolutionCache(ROOT, (x) => x, COMPILER_OPTIONS);

type Resolution =
  | { kind: "local"; file: string }
  | { kind: "external"; file: string }
  | { kind: "unresolved" };

/** Ask the compiler. Injectable ONLY so the fail-closed path can be proved. */
type Resolver = (specifier: string, fromFile: string) => Resolution;

const compilerResolver: Resolver = (specifier, fromFile) => {
  const { resolvedModule } = ts.resolveModuleName(
    specifier,
    fromFile,
    COMPILER_OPTIONS,
    ts.sys,
    RESOLUTION_CACHE,
  );
  if (!resolvedModule) return { kind: "unresolved" };
  const file = resolvedModule.resolvedFileName;
  // node_modules lives outside this worktree (it is shared), so a ROOT prefix
  // test would misclassify. The compiler's own flag is the answer.
  const external =
    resolvedModule.isExternalLibraryImport === true || file.includes("/node_modules/");
  return external ? { kind: "external", file } : { kind: "local", file };
};

/**
 * Every STATIC ESM reference this scanner extracts, classified into exactly one
 * state. Within that set there is no fourth path and no silent one.
 *
 *   RESOLVED_LOCAL      a project source file — traversed
 *   RESOLVED_EXTERNAL   an installed package — not our source, not our contract
 *   TYPE_ONLY           an erased dependency — ALSO traversed, on purpose
 *   UNRESOLVED          unreadable or unresolvable — a violation
 *
 * THE QUALIFIER MATTERS. CommonJS is not extracted here at all, so
 * `require("./local")` in a reached module produces NO site — measured, not
 * assumed. The census below therefore cannot notice it either: it compares the
 * kind counts against `sites.length`, which already excludes syntax the scanner
 * never emitted. What the census proves is that nothing is lost BETWEEN
 * extraction and classification, not that every module reference in the file
 * reached extraction.
 *
 * That gap is the deliberate boundary of this architecture, not an oversight:
 * `require` in FIN-owned source is an ESLint error, and in shared modules it is
 * outside what this file claims. See the block comment above.
 */
type SiteKind = "resolved_local" | "resolved_external" | "type_only" | "unresolved";

/** The AST form a site came from, for the census over extracted sites. */
type SiteSyntax = "import" | "export-from" | "import-type" | "dynamic-import";

type DependencySite = {
  kind: SiteKind;
  syntax: SiteSyntax;
  detail: string;
  /** The literal specifier, when the site had a readable one. */
  specifier?: string;
  /** Present exactly when the site resolved. */
  file?: string;
};

/**
 * Whether an import or re-export is ERASED at emit, and so cannot execute the
 * module it names.
 *
 * Measured against this repository's options rather than assumed:
 * `verbatimModuleSyntax` is not set, so `import type { X } from "m"`,
 * `import { type X } from "m"`, `import type * as ns from "m"` and
 * `export type { X } from "m"` all emit nothing at all. A clause with NO named
 * bindings is not erased — `import "m"` and `import {} from "m"` both execute.
 */
const isErasedModuleReference = (node: ts.ImportDeclaration | ts.ExportDeclaration): boolean => {
  if (ts.isImportDeclaration(node)) {
    const clause = node.importClause;
    if (!clause) return false;
    if (clause.isTypeOnly) return true;
    if (clause.name) return false;
    const bindings = clause.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      return bindings.elements.length > 0 && bindings.elements.every((e) => e.isTypeOnly);
    }
    return false;
  }
  if (node.isTypeOnly) return true;
  const clause = node.exportClause;
  if (clause && ts.isNamedExports(clause)) {
    return clause.elements.length > 0 && clause.elements.every((e) => e.isTypeOnly);
  }
  return false;
};

/**
 * ONE pass over a module's STATIC ESM dependency syntax.
 *
 * CommonJS is not analysed here at all any more — see the block comment above.
 * `require(...)` in a FIN-owned module is an ESLint error; in a shared module it
 * is outside what this file claims.
 */
function scanDependencies(
  source: string,
  fileName: string,
  resolver: Resolver = compilerResolver,
): DependencySite[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const sites: DependencySite[] = [];
  const at = (node: ts.Node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

  /**
   * The ONLY route into a resolved site. A non-literal specifier, or one the
   * compiler cannot resolve, becomes UNRESOLVED — never absent.
   */
  const dependency = (
    specifierNode: ts.Node | undefined,
    syntax: SiteSyntax,
    site: ts.Node,
    typeOnly: boolean,
  ) => {
    if (!specifierNode || !ts.isStringLiteralLike(specifierNode)) {
      sites.push({
        kind: "unresolved",
        syntax,
        detail: `line ${at(site)}: ${syntax} — the specifier is not a literal, so it cannot be followed`,
      });
      return;
    }
    const specifier = specifierNode.text;
    const resolution = resolver(specifier, fileName);
    if (resolution.kind === "unresolved") {
      sites.push({
        kind: "unresolved",
        syntax,
        detail: `line ${at(site)}: ${syntax} "${specifier}" — the compiler cannot resolve it`,
        specifier,
      });
      return;
    }
    sites.push({
      kind: typeOnly
        ? "type_only"
        : resolution.kind === "external"
          ? "resolved_external"
          : "resolved_local",
      syntax,
      detail: `line ${at(site)}: ${syntax} "${specifier}"`,
      specifier,
      file: resolution.file,
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      // Side-effect imports land here too: no importClause, but a specifier.
      dependency(node.moduleSpecifier, "import", node, isErasedModuleReference(node));
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      // `export * as ns from "m"` included. A bare `export { a }` re-exports
      // nothing from elsewhere and is not a dependency site.
      dependency(node.moduleSpecifier, "export-from", node, isErasedModuleReference(node));
    } else if (ts.isImportTypeNode(node)) {
      dependency(
        ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined,
        "import-type",
        node,
        /* typeOnly */ true,
      );
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      // `(import)("m")` is a PARSE ERROR — measured — so the callee needs no
      // normalisation. The ARGUMENT is where something can hide.
      dependency(node.arguments[0], "dynamic-import", node, /* typeOnly */ false);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return sites;
}

/** Local project files a module depends on, type-only edges included. */
function localTargets(sites: readonly DependencySite[]): string[] {
  const out: string[] = [];
  for (const site of sites) {
    const isLocal = site.kind === "resolved_local" || site.kind === "type_only";
    if (isLocal && site.file && !site.file.includes("/node_modules/")) out.push(site.file);
  }
  return out;
}

/** Dependency syntax that cannot be read or resolved. */
function violationsOf(sites: readonly DependencySite[]): string[] {
  return sites.filter((s) => s.kind === "unresolved").map((s) => s.detail);
}

const dependencySites = (file: string): DependencySite[] =>
  scanDependencies(readFileSync(file, "utf8"), file);

function dependencyViolations(source: string, fileName: string): string[] {
  return violationsOf(scanDependencies(source, fileName));
}

/** The literal specifiers a source names, whatever became of them. */
function specifiersOfSource(source: string, fileName: string): string[] {
  return scanDependencies(source, fileName)
    .map((site) => site.specifier)
    .filter((specifier): specifier is string => specifier !== undefined);
}

/**
 * file -> the importer that first reached it, so a failure names a chain.
 *
 * `sitesOf` is injectable so the fail-closed behaviour of a RESOLVER that
 * returns nothing for a perfectly readable literal can be tested. Production
 * callers take the default.
 */
function walkFrom(
  entries: readonly string[],
  sitesOf: (file: string) => DependencySite[] = dependencySites,
): Map<string, string | null> {
  const reached = new Map<string, string | null>();
  const queue: Array<[string, string | null]> = entries.map((e) => [path.join(ROOT, e), null]);
  while (queue.length > 0) {
    const [file, via] = queue.shift()!;
    if (reached.has(file)) continue;
    reached.set(file, via);
    for (const target of localTargets(sitesOf(file))) {
      if (!reached.has(target)) queue.push([target, path.relative(ROOT, file)]);
    }
  }
  return reached;
}

const FIN_ENTRIES = Object.values(FILES);
const CLOSURE = walkFrom(FIN_ENTRIES);
const CLOSURE_REL = [...CLOSURE.keys()].map((f) => path.relative(ROOT, f)).sort();

/**
 * The FIN-01A truth contract's banned identifiers, as *reachability* rules.
 * Service value, practitioner-attested settlement and Hone-verified money — the
 * three classes Slice 1 answers none of — plus the dormant and legacy decoys.
 */
const FORBIDDEN_ON_THE_PATH = [
  "price_cents",
  "price_paid_cents",
  "quoted_amount_cents",
  "amount_cents",
  "payment_charge_attempts",
  "appointment_settlements",
  "manual_fee_charge_attempts",
  "stripe_charge_attempts",
  "appointment_payments",
  "stripe_refunds",
  "stripe_refund_attempts",
  "charged_at",
  "refunded_at",
  "refund_status",
  "stripe_livemode",
  "inferStripeLivemode",
];

/**
 * Occurrences of a forbidden identifier in VALUE position — the ones that could
 * be a read. A type declaration NAMES a column; it does not read one.
 *
 * THIS REPLACED A FILE-LEVEL EXEMPTION, and the reason is worth keeping. The
 * scan used to skip `lib/types/database.ts` wholesale, justified as
 * "declaration-only". Codex checked that premise and it was false: the file
 * exports `KNOWN_MODALITIES`, a runtime value. So a future executable helper
 * there using `price_cents` would have evaded the scan entirely, while the
 * follow-up assertion still passed as long as it avoided four query markers.
 * The exemption was justified by a property nobody had verified.
 *
 * Position is the honest boundary, and it needs no allowlist: every one of the
 * four forbidden identifiers in that file is a `name: type` property signature,
 * so the file passes on its merits and the exemption set is gone.
 *
 * Comments are excluded by construction — only nodes that carry text are
 * inspected, and a comment is not one. Template parts, JSX text, private
 * identifiers and the expression of a class `extends` clause ARE inspected.
 *
 * The contract is narrower than "every money reference", and deliberately so:
 * the scan covers the runtime identifier forms represented by the TypeScript
 * syntax classes its controls exercise, while excluding the type-only
 * positions those same controls pin. It previously claimed to lose "none of
 * the reach" of the text search it replaced; review then found two forms it
 * had silently dropped — the runtime expression of an `extends` clause, and
 * every PrivateIdentifier. Both are covered below. The claim is not restored,
 * because what disproved it was a syntax class nobody had thought to list.
 */
function forbiddenValueOccurrences(source: string, fileName: string): string[] {
  const sf = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const hits: string[] = [];
  const visit = (node: ts.Node, inType: boolean): void => {
    const nowInType =
      inType ||
      ts.isTypeNode(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node);
    const carriesText =
      ts.isIdentifier(node) ||
      // A PrivateIdentifier is NOT an Identifier — `ts.isIdentifier` is false
      // for it — and its `.text` keeps the `#`. Without this arm a class that
      // held money in `#price_cents` escaped at the declaration AND at every
      // `this.#…` read.
      ts.isPrivateIdentifier(node) ||
      ts.isStringLiteralLike(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isJsxText(node);
    if (!nowInType && carriesText) {
      for (const id of FORBIDDEN_ON_THE_PATH) {
        if (node.text.includes(id)) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          hits.push(`line ${line + 1}: "${id}"`);
        }
      }
    }
    // `ts.isTypeNode` answers TRUE for an ExpressionWithTypeArguments — the
    // node a heritage clause entry is — so the rule above erases the whole
    // entry. For `extends` that is wrong: in `class C extends makeBase(x) {}`
    // the ENTRY'S EXPRESSION runs, and only its type ARGUMENTS are erased.
    // `implements` stays erased entirely, and an interface's `extends` is
    // already in-type by the time it is reached, so it stays erased too.
    if (ts.isHeritageClause(node)) {
      const erased = nowInType || node.token !== ts.SyntaxKind.ExtendsKeyword;
      for (const entry of node.types) {
        visit(entry.expression, erased);
        for (const typeArgument of entry.typeArguments ?? []) {
          visit(typeArgument, /* inType */ true);
        }
      }
      return; // forEachChild(HeritageClause) visits exactly `types`; covered.
    }
    ts.forEachChild(node, (child) => visit(child, nowInType));
  };
  visit(sf, /* inType */ false);
  return hits;
}

/**
 * Every ESM shape the walker must see, with the answer WRITTEN DOWN rather than
 * computed. This is the one check that cannot go blind alongside the walker:
 * everything else in this block asks the extractor about the extractor.
 */
type Shape = [name: string, source: string, expected: string[]];

const MODULE_REFERENCE_SHAPES: Shape[] = [
  ["default import", 'import x from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["named import", 'import { known } from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["namespace import", 'import * as ns from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["side-effect import", 'import "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["export-from", 'export { known } from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["export-star", 'export * from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["export-star-as", 'export * as ns from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["dynamic import", 'const p = import("@/lib/finance/financial-fact");', ["@/lib/finance/financial-fact"]],
  ["dynamic import, template literal", "const p = import(`@/lib/finance/financial-fact`);", ["@/lib/finance/financial-fact"]],
  ["explicit .js specifier", 'import "@/lib/finance/financial-fact.js";', ["@/lib/finance/financial-fact.js"]],
  ["import type", 'import type { Fact } from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["inline type specifier", 'import { type Fact } from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["export type from", 'export type { Fact } from "@/lib/finance/financial-fact";', ["@/lib/finance/financial-fact"]],
  ["import type position", 'type X = import("@/lib/finance/financial-fact").Fact<number>;', ["@/lib/finance/financial-fact"]],
  // ...and what must NOT become an edge.
  ["line-commented import", '// import "@/lib/finance/financial-fact";', []],
  ["block-commented import", '/* import "@/lib/finance/financial-fact"; */', []],
  ["a string that spells one", `const s = 'import "@/lib/finance/financial-fact"';`, []],
  ["a non-literal dynamic import", "const p = import(dynamicName);", []],
];

describe("NC-reach — the extractor sees every ESM module reference", () => {
  it.each(MODULE_REFERENCE_SHAPES)("%s", (_name, source, expected) => {
    expect(specifiersOfSource(source, path.join(ROOT, "lib/finance/probe.ts"))).toEqual(expected);
    expect(specifiersOfSource(source, path.join(ROOT, "lib/finance/probe.tsx"))).toEqual(expected);
  });

  it("an ESM edge is walked TRANSITIVELY, not just recognised at the entry", () => {
    // Recognising a specifier is half the job: the queue must also FOLLOW it.
    const CHAIN: Record<string, string> = {
      [FILES.model]: 'import "@/lib/finance/financial-copy";',
      "lib/finance/financial-copy.ts": 'import "@/lib/dashboard/practice-metrics";',
    };
    const reached = walkFrom([FILES.model], (file) =>
      scanDependencies(CHAIN[path.relative(ROOT, file)] ?? "", file),
    );
    expect([...reached.keys()].map((f) => path.relative(ROOT, f))).toEqual([
      FILES.model,
      "lib/finance/financial-copy.ts",
      "lib/dashboard/practice-metrics.ts",
    ]);
  });

  it("THE MONEY MODULE: an ESM edge to it resolves, and it really is a money path", () => {
    const entry = path.join(ROOT, FILES.model);
    const specs = specifiersOfSource('import "@/lib/dashboard/practice-metrics";', entry);
    expect(specs).toEqual(["@/lib/dashboard/practice-metrics"]);

    const resolution = compilerResolver(specs[0], entry);
    expect(resolution.kind).toBe("local");
    expect(
      resolution.kind === "local" ? path.relative(ROOT, resolution.file) : resolution.kind,
    ).toBe("lib/dashboard/practice-metrics.ts");

    const money = codeOnly(read("lib/dashboard/practice-metrics.ts"));
    expect(FORBIDDEN_ON_THE_PATH.filter((id) => money.includes(id))).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. Static dependencies fail closed
// ---------------------------------------------------------------------------

describe("NC-static — an unreadable or unresolvable dependency is a violation", () => {
  const probe = path.join(ROOT, "lib/finance/probe.ts");

  it.each([
    ['import("@/lib/dashboard/" + "practice-metrics");', "concatenated specifier"],
    ['const s = "@/lib/dashboard/practice-metrics"; import(s);', "variable specifier"],
    ['import(c ? "./a" : "@/lib/dashboard/practice-metrics");', "conditional specifier"],
    ["import(`@/lib/dashboard/${name}`);", "substituted template"],
  ])("%s is UNRESOLVED, not absent", (source) => {
    const sites = scanDependencies(source, probe);
    expect(sites.map((s) => s.kind)).toEqual(["unresolved"]);
    expect(violationsOf(sites).join(" ")).toMatch(/not a literal/);
    expect(localTargets(sites)).toEqual([]);
  });

  it("NO CONSTANT FOLDING: a concatenation naming a SAFE module is rejected too", () => {
    // Legibility is the rule, not the destination. Folding would be the first
    // step back towards interpreting JavaScript.
    const sites = scanDependencies('import("@/lib/finance/" + "financial-fact");', probe);
    expect(sites.map((s) => s.kind)).toEqual(["unresolved"]);
  });

  it("a literal the compiler cannot resolve is a violation", () => {
    for (const source of ['import "@/lib/does/not/exist";', 'import "./nope/nowhere";']) {
      const sites = scanDependencies(source, probe);
      expect(sites.map((s) => s.kind), source).toEqual(["unresolved"]);
      expect(violationsOf(sites).join(" ")).toMatch(/cannot resolve/);
    }
  });

  it("EVERY SITE HAS EXACTLY ONE KIND", () => {
    const kindsOf = (source: string) => scanDependencies(source, probe).map((s) => s.kind);
    expect(kindsOf('import "@/lib/finance/financial-fact";')).toEqual(["resolved_local"]);
    expect(kindsOf('import * as React from "react";')).toEqual(["resolved_external"]);
    expect(kindsOf('import type { Fact } from "@/lib/finance/financial-fact";')).toEqual([
      "type_only",
    ]);
    expect(kindsOf("import(x);")).toEqual(["unresolved"]);
    expect(kindsOf('import "@/lib/does/not/exist";')).toEqual(["unresolved"]);

    const mixed = scanDependencies(
      [
        'import "@/lib/finance/financial-fact";',
        'import * as React from "react";',
        'import type { Fact } from "@/lib/finance/financial-copy";',
        "import(x);",
      ].join("\n"),
      probe,
    );
    expect(mixed.map((s) => s.kind).sort()).toEqual(
      ["resolved_external", "resolved_local", "type_only", "unresolved"].sort(),
    );
    expect(mixed).toHaveLength(4);
  });

  it("NO MODULE IN THE FIN CLOSURE HAS AN UNREADABLE DEPENDENCY", () => {
    const offences: string[] = [];
    for (const [file, via] of CLOSURE) {
      const rel = path.relative(ROOT, file);
      for (const violation of dependencyViolations(readFileSync(file, "utf8"), file)) {
        offences.push(`${rel} ${violation} (reached via ${via ?? "entry point"})`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("LOAD-BEARING: a recognised literal the resolver cannot resolve turns the guard RED", () => {
    // Extraction succeeds and only RESOLUTION fails — the stage that used to
    // produce silence. A resolver that resolves nothing stands in for the
    // hand-written prober that could not follow `practice-metrics.js`.
    const blindResolver: Resolver = () => ({ kind: "unresolved" });
    const sites = scanDependencies('import "@/lib/finance/financial-fact";', probe, blindResolver);
    expect(sites.map((s) => s.kind)).toEqual(["unresolved"]);
    expect(localTargets(sites)).toEqual([]);

    const reached = walkFrom(FIN_ENTRIES, (file) =>
      scanDependencies(readFileSync(file, "utf8"), file, blindResolver),
    );
    expect(reached.size).toBe(FIN_ENTRIES.length);

    // The real resolver, on the same tree, produces no violation at all.
    expect(violationsOf(dependencySites(path.join(ROOT, FILES.model)))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10. The money-path closure
// ---------------------------------------------------------------------------

describe("NC-reach — money is confined to the FIN-owned modules of the closure", () => {
  it("ANTI-VACUITY: the walk actually resolved a real graph", () => {
    expect(CLOSURE.size).toBeGreaterThanOrEqual(12);
    expect(CLOSURE_REL).toContain("lib/booking/reporting-period.ts");
    expect(CLOSURE_REL).toContain("lib/booking/tz.ts");
    expect(CLOSURE_REL).toContain("lib/supabase/queries.ts");
    expect(CLOSURE_REL).toContain("lib/types/database.ts");
  });

  it("CLOSURE IS CLOSED: every local edge of a reached file is itself reached", () => {
    const escaped: string[] = [];
    for (const file of CLOSURE.keys()) {
      for (const target of localTargets(dependencySites(file))) {
        if (!CLOSURE.has(target)) {
          escaped.push(`${path.relative(ROOT, file)} -> ${path.relative(ROOT, target)}`);
        }
      }
    }
    expect(escaped).toEqual([]);
  });

  it("THE MONEY MODULE is not in the closure", () => {
    expect(CLOSURE_REL).not.toContain("lib/dashboard/practice-metrics.ts");
    expect(CLOSURE_REL.filter((f) => f.startsWith("lib/dashboard/"))).toEqual([]);
  });

  it("money is named ONLY by the FIN-owned modules, nowhere else in the closure", () => {
    // THE CONTRACT INVERTED FOR SLICE 2, and deliberately not weakened.
    //
    // Slice 1 proved no module in the closure named money at all. Slice 2 reads
    // money, so that assertion is now false BY DESIGN — and the useful claim is
    // the one that survives: money identifiers appear in the four FIN-owned
    // modules that are entitled to them, and in NO other module the compiler
    // can reach from this route.
    //
    // What that still catches is the failure that mattered: a shared utility,
    // a type module or a booking helper quietly growing a money read, and
    // reaching this surface through a dependency nobody re-examined.
    //
    // Position is still the boundary. lib/types/database.ts is in the closure
    // and names `price_cents` as a `name: type` property signature; it passes
    // on its merits, not on an exemption.
    const OWNED = /^(lib\/finance\/|app\/\(app\)\/financials\/)/;
    // lib/stripe/livemode.ts is entitled to EXACTLY ONE of these names — its
    // own export — and to nothing else. Granted as a named identifier rather
    // than as a file exemption, because a file exemption is what let a money
    // helper hide inside lib/types/database.ts in the first place: the premise
    // "declaration only" was never verified and turned out to be false. The
    // next author who adds a ledger read to this file trips this test.
    const ENTITLED: ReadonlyMap<string, ReadonlySet<string>> = new Map([
      ["lib/stripe/livemode.ts", new Set(["inferStripeLivemode"])],
    ]);
    const offences: string[] = [];
    for (const [file, via] of CLOSURE) {
      const rel = path.relative(ROOT, file);
      if (OWNED.test(rel)) continue;
      const entitled = ENTITLED.get(rel);
      if (entitled) {
        for (const hit of forbiddenValueOccurrences(readFileSync(file, "utf8"), file)) {
          const named = FORBIDDEN_ON_THE_PATH.find((id) => hit.includes(`"${id}"`));
          if (named === undefined || !entitled.has(named)) {
            offences.push(`${rel} ${hit} (reached via ${via ?? "entry point"})`);
          }
        }
        continue;
      }
      for (const hit of forbiddenValueOccurrences(readFileSync(file, "utf8"), file)) {
        offences.push(`${rel} ${hit} (reached via ${via ?? "entry point"})`);
      }
    }
    expect(offences).toEqual([]);
  });

  it("ANTI-VACUITY: the FIN-owned modules DO name money, so the exclusion is load-bearing", () => {
    // Without this, the rule above could pass by the closure having no money in
    // it at all — which is what Slice 1 asserted and Slice 2 must not.
    // The entitlement above must also be load-bearing rather than decorative:
    // the leaf module really is in the closure, and really does name the flag.
    const leaf = path.join(ROOT, "lib/stripe/livemode.ts");
    expect(CLOSURE.has(leaf)).toBe(true);
    expect(forbiddenValueOccurrences(readFileSync(leaf, "utf8"), leaf)).not.toEqual([]);

    const owned = [FILES.loader, FILES.model].map((rel) => path.join(ROOT, rel));
    for (const file of owned) {
      expect(
        forbiddenValueOccurrences(readFileSync(file, "utf8"), file),
        path.relative(ROOT, file),
      ).not.toEqual([]);
      expect(CLOSURE.has(file), `${path.relative(ROOT, file)} must be in the closure`).toBe(true);
    }
  });

  it("the position rule distinguishes a declaration from a read", () => {
    // Without this the rule could pass by seeing nothing at all. A shape is
    // clean; every way the money module actually reads a column is not.
    const probe = path.join(ROOT, "lib/finance/probe.ts");
    expect(forbiddenValueOccurrences("export interface S { price_cents: number | null }", probe)).toEqual([]);
    expect(forbiddenValueOccurrences("export type S = { price_paid_cents: number }", probe)).toEqual([]);
    expect(forbiddenValueOccurrences("// price_cents is never read\nexport const a = 1;", probe)).toEqual([]);
    for (const realRead of [
      'const r = db.from("services").select("price_cents");',
      "export const v = row.price_cents;",
      'const cols = "status, price_cents";',
      "export const o = { price_cents: 1 };",
      "const q = `select price_cents from x ${t}`;",
    ]) {
      expect(forbiddenValueOccurrences(realRead, probe), realRead).not.toEqual([]);
    }
    // ...and the real money module trips it, so the rule is aimed at something.
    expect(
      forbiddenValueOccurrences(read("lib/dashboard/practice-metrics.ts"), path.join(ROOT, "lib/dashboard/practice-metrics.ts")),
    ).not.toEqual([]);
  });

  it("HERITAGE: a class `extends` EXPRESSION runs; its type ARGUMENTS do not", () => {
    // Found by review, not by us. `ts.isTypeNode` is TRUE for an
    // ExpressionWithTypeArguments, so "type node ⇒ erased" hid every money
    // read underneath an extends clause — the scan reported GREEN on a real
    // runtime call. These assert the scanner directly, not the closure, so a
    // regression here fails on its own rather than behind another assertion.
    const probe = path.join(ROOT, "lib/finance/probe.ts");
    for (const runtime of [
      "class C extends makeBase(row.price_cents) {}",
      "class C extends (flag ? makeBase(row.price_cents) : Other) {}",
      "const K = class extends makeBase(row.price_cents) {};",
    ]) {
      expect(forbiddenValueOccurrences(runtime, probe), runtime).not.toEqual([]);
    }
    // ...and the erased half of the very same clause stays erased. Widening
    // `extends` must not drag type arguments or `implements` along with it.
    for (const erased of [
      "class C extends Base<price_cents> {}",
      "class C extends makeBase<price_cents>() {}",
      "class C implements price_cents {}",
      "interface I extends Base<price_cents> {}",
      "class C extends Base {}",
    ]) {
      expect(forbiddenValueOccurrences(erased, probe), erased).toEqual([]);
    }
  });

  it("PRIVATE FIELDS: `#price_cents` is a runtime name the scan must see", () => {
    // Also found by review. `ts.isIdentifier` is false for a PrivateIdentifier,
    // so money kept in a private field was invisible at the declaration and at
    // every read of it.
    const probe = path.join(ROOT, "lib/finance/probe.ts");
    for (const runtime of [
      "class C { #price_cents = 1 }",
      "class C {\n  #price_cents = 1;\n  read() { return this.#price_cents; }\n}",
      "class C { #price_cents = 1; has(o: object) { return #price_cents in o; } }",
    ]) {
      expect(forbiddenValueOccurrences(runtime, probe), runtime).not.toEqual([]);
    }
    // A private field is not forbidden for being private.
    const safe = "class C {\n  #safe_field = 1;\n  read() { return this.#safe_field; }\n}";
    expect(forbiddenValueOccurrences(safe, probe), safe).toEqual([]);
  });

  it("COUNTERWEIGHT: a name in a true type POSITION is still erased", () => {
    // The two repairs above widen the scan; this is what stops them widening
    // it into "every name inside a type is a read". Each entry below is a
    // genuine ts.TypeNode, which is the property the erasure rule keys on.
    //
    // NOT a claim of zero false positives. Measured exception: a type-only
    // import or export SPECIFIER (`import type { price_cents } from …`) is an
    // Identifier in no TypeNode, so the scan reports it. That predates these
    // repairs and is unchanged by them, it errs towards reporting rather than
    // missing, and no file in the closure trips it — so it is recorded here
    // rather than silently fixed inside a bounded repair.
    const probe = path.join(ROOT, "lib/finance/probe.ts");
    for (const erased of [
      "declare const x: { price_cents: number }; export const y = 1;",
      "export const y = new Map<string, price_cents>();",
      "export function f<T extends price_cents>(t: T) { return t }",
      "export const y = ({} as unknown) as { price_cents: number };",
      "export function g(x: unknown): x is price_cents { return true }",
      "export type Q = typeof price_cents; export const z = 1;",
    ]) {
      expect(forbiddenValueOccurrences(erased, probe), erased).toEqual([]);
    }
  });

  it("TOTAL equals the sum of the kinds, for every module in the closure", () => {
    // What this proves: every site object the scanner DID emit carries one of
    // the four counted kinds, so none is classified into nothing. What it
    // cannot prove: that a reference reached the scanner at all. A dropped
    // reference emits no site, so the sum and `sites.length` fall together and
    // this stays green — which is why the header above scopes the census to
    // extracted static ESM references.
    for (const file of CLOSURE.keys()) {
      const sites = dependencySites(file);
      const sum =
        sites.filter((s) => s.kind === "resolved_local").length +
        sites.filter((s) => s.kind === "resolved_external").length +
        sites.filter((s) => s.kind === "type_only").length +
        sites.filter((s) => s.kind === "unresolved").length;
      expect(sum, path.relative(ROOT, file)).toBe(sites.length);
    }
  });
});

// ---------------------------------------------------------------------------
// 11. The FIN-owned coding constraint
// ---------------------------------------------------------------------------
//
// This is the OTHER half of the architecture, and it is a CONSTRAINT rather
// than a proof. In app/(app)/financials/** and lib/finance/**, eslint.config.mjs
// configures three rules, whose families are:
//
//   * a value-position `require`, `module` or `exports`, in any expression
//     shape;
//   * a STATIC import or re-export of "node:module" or "module", type-only
//     included;
//   * `process.getBuiltinModule`, dotted or with a literal computed key.
//
// `npm run lint` runs it on every diff.
//
// These rules are a coding constraint. They are not a complete runtime-loader
// proof, not a security boundary, and not a claim about every way JavaScript
// can acquire a module.
//
// Tested here for one reason: a lint rule nobody exercises is a comment. Each
// assertion below names the RULE it expects, so a control cannot pass because
// some unrelated rule happened to fire on the fixture.
//
// The scope is honest and narrow. These rules bind app/(app)/financials/** and
// lib/finance/** — the six modules FIN owns. The other eleven in the closure
// are shared infrastructure, and a test below proves the rules do NOT reach
// them, so nobody mistakes this for a repository-wide boundary.

const FIN_OWNED_PROBE = path.join(ROOT, "lib/finance/__lint_probe.ts");
const SHARED_PROBE = path.join(ROOT, "lib/booking/__lint_probe.ts");

/** Rule ids ESLint reports for a source, without writing anything to disk. */
async function lintRuleIds(source: string, filePath: string): Promise<string[]> {
  const { ESLint } = await import("eslint");
  const eslint = new ESLint({ cwd: ROOT });
  const [result] = await eslint.lintText(source, { filePath });
  return (result?.messages ?? [])
    .map((m) => m.ruleId)
    .filter((id): id is string => id !== null);
}

describe("NC-lint — the configured rules reject these FIN-owned loader forms", () => {
  // One fixture per form, asserted BY RULE ID so a control cannot pass because
  // some unrelated rule fired on the fixture. These prove the listed forms ARE
  // rejected; they do not prove that nothing else can acquire a module.
  it.each([
    // no-restricted-globals: any value-position use, whatever the shape.
    ["require, called", 'export const a = require("x");', "no-restricted-globals"],
    ["require, aliased", "export const a = require;", "no-restricted-globals"],
    ["require, parenthesized", 'export const a = (require)("x");', "no-restricted-globals"],
    ["require, instantiated", 'export const a = ((require as <T>(i: string) => T)<string>)("x");', "no-restricted-globals"],
    ["require, conditional", 'declare const f: boolean;\nexport const a = (f ? require : require)("x");', "no-restricted-globals"],
    ["require, comma sequence", 'export const a = (0, require)("x");', "no-restricted-globals"],
    ["module, dotted member", 'export const a = module.require("x");', "no-restricted-globals"],
    ["module, computed member", 'export const a = module["require"]("x");', "no-restricted-globals"],
    ["module, concatenated key", 'export const a = module["requ" + "ire"]("x");', "no-restricted-globals"],
    ["module, bare reference", "export const a = module;", "no-restricted-globals"],
    ["exports, assigned", "exports.x = 1;", "no-restricted-globals"],
    // no-restricted-imports: STATIC forms only, type-only included.
    ["static named import", 'import { createRequire } from "node:module";\nexport const a = createRequire;', "no-restricted-imports"],
    ["static renamed import", 'import { createRequire as cr } from "node:module";\nexport const a = cr;', "no-restricted-imports"],
    ["static namespace import", 'import * as nm from "node:module";\nexport const a = nm;', "no-restricted-imports"],
    ["static default import", 'import nm from "node:module";\nexport const a = nm;', "no-restricted-imports"],
    ["static side-effect import", 'import "node:module";', "no-restricted-imports"],
    ["static import of bare module", 'import m from "module";\nexport const a = m;', "no-restricted-imports"],
    ["re-export from node:module", 'export { createRequire } from "node:module";', "no-restricted-imports"],
    ["type-only import", 'import type { RequireResolve } from "node:module";\nexport type A = RequireResolve;', "no-restricted-imports"],
    // no-restricted-properties: the literal `process` object.
    ["process.getBuiltinModule", 'export const a = process.getBuiltinModule("module");', "no-restricted-properties"],
    ['process["getBuiltinModule"]', 'export const a = process["getBuiltinModule"]("module");', "no-restricted-properties"],
  ])("%s is rejected in FIN-owned source", async (_name, source, expectedRule) => {
    const ruleIds = await lintRuleIds(source, FIN_OWNED_PROBE);
    expect(ruleIds, `${source} -> ${ruleIds.join(", ")}`).toContain(expectedRule);
  });

  it("a locally bound `require` is correctly NOT flagged", async () => {
    // Not a gap: a parameter named `require` is a local binding, not the
    // loader. Flagging it would be a false positive, and no-restricted-globals
    // is right to ignore it.
    const ruleIds = await lintRuleIds(
      'export function f(require: (i: string) => unknown) { return require("x"); }',
      FIN_OWNED_PROBE,
    );
    expect(ruleIds).not.toContain("no-restricted-globals");
  });

  it("approved FIN ESM source stays clean", async () => {
    const ruleIds = await lintRuleIds(
      'import { known } from "@/lib/finance/financial-fact";\nexport const a = known(1);\n',
      FIN_OWNED_PROBE,
    );
    expect(ruleIds).toEqual([]);
  });

  it("an object KEY named require or module is not a use of one", async () => {
    const ruleIds = await lintRuleIds(
      "export const o = { require: 1, module: 2 };",
      FIN_OWNED_PROBE,
    );
    expect(ruleIds).toEqual([]);
  });

  it("SCOPE IS NARROW, and the limit is stated rather than hidden", async () => {
    // Eleven of the seventeen modules in CLOSURE are shared, so this constraint
    // covers six. Asserted so the claim cannot quietly widen.
    const ruleIds = await lintRuleIds(
      'import * as nm from "node:module";\nexport const a = nm;',
      SHARED_PROBE,
    );
    expect(ruleIds).not.toContain("no-restricted-imports");
  });

  it("FIN-owned source contains none of these today", async () => {
    for (const rel of FIN_ENTRIES) {
      const ruleIds = await lintRuleIds(read(rel), path.join(ROOT, rel));
      expect(ruleIds, rel).toEqual([]);
    }
  });
});
